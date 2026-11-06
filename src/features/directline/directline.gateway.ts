import {
    BadRequestException,
    Injectable,
    Logger,
    OnModuleDestroy,
    OnModuleInit,
    UnauthorizedException
} from '@nestjs/common';
import { Server as WSServer, WebSocket } from 'ws';
import { IncomingMessage } from 'http';
import { AddressInfo } from 'net';
import { Transcript } from 'botframework-schema';
import { ConfigService } from '@nestjs/config';
import { DirectlineTokenService } from './dirtectline-token.service';

// RFC 6455 close codes
const NORMAL_CLOSURE = 1000; // a newer socket took over the conversation
const GOING_AWAY = 1001; // the server is shutting down
const POLICY_VIOLATION = 1008; // the connection was refused for a policy reason (bad or missing token)

export type DeliveryResult = 'sent' | 'no_open_socket' | 'send_failed';

export interface DirectLineGatewayStats {
    listening: boolean;
    clients: number;
    conversations: number;
    pendingDeliveries: number;
    counters: {
        connectionsAccepted: number;
        connectionsRejected: number;
        connectionsReplaced: number;
        connectionsClosed: number;
        socketErrors: number;
        heartbeatTimeouts: number;
        deliveriesSent: number;
        deliveriesNoOpenSocket: number;
        deliveriesFailed: number;
        deliveriesWaited: number;
    };
}

@Injectable()
export class DirectLineGateway implements OnModuleInit, OnModuleDestroy {
    private readonly logger = new Logger(this.constructor.name);
    private wss: WSServer;
    private listening = false;
    private heartbeat?: NodeJS.Timeout;
    // Sockets that answered the last ping (or connected since); one missing from here at the next ping is dead
    private readonly alive = new WeakSet<WebSocket>();
    // Conversation id to socket
    private readonly socketMeta = new Map<string, WebSocket>();
    // Deliveries waiting for a conversation's socket to register, woken by handleConnection
    private readonly waiters = new Map<string, Set<(ws?: WebSocket) => void>>();
    private readonly socketPort: number;
    private readonly deliveryWaitMs: number;
    private readonly heartbeatIntervalMs: number;
    private readonly closeGraceMs: number;
    private pendingDeliveries = 0;
    private readonly counters: DirectLineGatewayStats['counters'] = {
        connectionsAccepted: 0,
        connectionsRejected: 0,
        connectionsReplaced: 0,
        connectionsClosed: 0,
        socketErrors: 0,
        heartbeatTimeouts: 0,
        deliveriesSent: 0,
        deliveriesNoOpenSocket: 0,
        deliveriesFailed: 0,
        deliveriesWaited: 0
    };

    constructor(
        private readonly directLineTokenService: DirectlineTokenService,
        configService: ConfigService
    ) {
        this.socketPort = Number(configService.get<number>('SOCKET_PORT'));
        this.deliveryWaitMs = Number(configService.get('SOCKET_DELIVERY_WAIT_MS')) || 6_000;
        this.heartbeatIntervalMs = Number(configService.get('SOCKET_HEARTBEAT_INTERVAL_MS')) || 30_000;
        this.closeGraceMs = Number(configService.get('SOCKET_CLOSE_GRACE_MS')) || 5_000;
    }

    /**
     * Binds the stream listener. Resolves once it is listening, so the application is not ready before the stream
     * endpoint is, and rejects when it cannot bind (e.g. EADDRINUSE) so startup fails instead of leaving HTTP up alone.
     */
    onModuleInit(): Promise<void> {
        this.wss = new WSServer({ port: this.socketPort });
        this.wss.on('connection', (ws: WebSocket, req: IncomingMessage) => this.handleConnection(ws, req));
        this.wss.on('close', () => {
            this.listening = false;
        });

        return new Promise<void>((resolve, reject) => {
            const failedToBind = (err: Error) => reject(err);
            this.wss.once('error', failedToBind);
            this.wss.once('listening', () => {
                this.wss.off('error', failedToBind);
                this.wss.on('error', (err: Error) => {
                    this.logger.error(`WebSocket error ${err}`);
                });
                this.listening = true;
                this.startHeartbeat();
                this.logger.log(`WebSocket server started on port ${(this.wss.address() as AddressInfo).port}`);
                resolve();
            });
        });
    }

    handleConnection(ws: WebSocket, req: IncomingMessage) {
        // Attached before validation: an 'error' event with no listener is thrown, and would take the process down
        ws.on('error', (err: Error) => {
            this.counters.socketErrors++;
            this.logger.error(`WebSocket error ${err}`);
        });

        let conv: string;
        try {
            const parsedUrl = new URL(`wss://server${req?.url ?? ''}`);
            const token = parsedUrl.searchParams.get('t');
            if (token === null) {
                throw new UnauthorizedException('Missing token');
            }
            const directLineTokenPayload = this.directLineTokenService.verifyDirectLineToken(token);
            const match = parsedUrl.pathname.match(/^\/v3\/directline\/conversations\/([^/]+)\/stream$/);
            if (!match || match[1] !== directLineTokenPayload.conv) {
                throw new BadRequestException('Erroneous link');
            }
            conv = directLineTokenPayload.conv;
        } catch (e: unknown) {
            this.counters.connectionsRejected++;
            ws.send(JSON.stringify({ error: e instanceof Error ? e.message : String(e) }));
            this.closeSocket(ws, POLICY_VIOLATION, 'Token rejected');
            return;
        }

        this.counters.connectionsAccepted++;
        this.alive.add(ws);
        ws.on('pong', () => this.alive.add(ws));
        ws.on('close', () => {
            this.counters.connectionsClosed++;
            // A newer socket for the same conversation replaces this one; only remove the entry we own
            if (this.socketMeta.get(conv) === ws) {
                this.socketMeta.delete(conv);
            }
        });

        const replaced = this.socketMeta.get(conv);
        this.socketMeta.set(conv, ws);
        this.logger.verbose(`Web-socket connected for conversation ${conv}`);
        // Deliveries that arrived before the socket go out now (each wake removes itself from the set)
        for (const wake of [...(this.waiters.get(conv) ?? [])]) {
            wake(ws);
        }
        if (replaced) {
            this.counters.connectionsReplaced++;
            this.closeSocket(replaced, NORMAL_CLOSURE, 'Replaced by a newer connection');
        }
    }

    /**
     * Drains the stream: stops pinging, tells every client the server is going away (they reconnect to the
     * replacement instance), cuts stragglers after the grace period and resolves once the listener has closed.
     */
    async onModuleDestroy() {
        // Deliveries still waiting for a socket will not get one
        for (const waiting of [...this.waiters.values()]) {
            for (const wake of [...waiting]) {
                wake();
            }
        }
        if (!this.wss) {
            return;
        }
        clearInterval(this.heartbeat);
        // The listener's close callback can fire a tick before ws has pruned its last client, so wait for both
        const gone = [...this.wss.clients].map(ws => {
            const closed = new Promise<void>(resolve => ws.once('close', () => resolve()));
            this.closeSocket(ws, GOING_AWAY, 'Server shutting down');
            return closed;
        });
        gone.push(new Promise<void>(resolve => this.wss.close(() => resolve())));
        await Promise.all(gone);
        this.socketMeta.clear();
    }

    /**
     * Push a transcript to the conversation's live socket. A bot can answer before the client's socket has
     * registered, so delivery waits for the socket and goes out the moment it registers, up to the delivery wait.
     * Delivery is best effort: a transcript that could not be pushed is reported in the result and the counters,
     * never queued or sent twice.
     */
    async sendToConversation(convId: string, activityPayload: Transcript): Promise<DeliveryResult> {
        this.pendingDeliveries++;
        try {
            const wsConnection = await this.openSocket(convId);
            if (!wsConnection) {
                this.counters.deliveriesNoOpenSocket++;
                this.logger.warn(`Could not send transcript to conversation ${convId} (no open socket)`);
                return 'no_open_socket';
            }
            return await this.transmit(wsConnection, convId, JSON.stringify(activityPayload));
        } finally {
            this.pendingDeliveries--;
        }
    }

    stats(): DirectLineGatewayStats {
        return {
            listening: this.listening,
            clients: this.wss?.clients.size ?? 0,
            conversations: this.socketMeta.size,
            pendingDeliveries: this.pendingDeliveries,
            counters: { ...this.counters }
        };
    }

    // Resolves with the conversation's open socket: right away when there is one, as soon as one registers otherwise,
    // or with nothing once the delivery wait runs out
    private openSocket(convId: string): Promise<WebSocket | undefined> {
        const current = this.socketMeta.get(convId);
        if (current?.readyState === WebSocket.OPEN) {
            return Promise.resolve(current);
        }
        this.counters.deliveriesWaited++;
        this.logger.verbose(`Waiting for conversation ${convId} to connect`);
        return new Promise(resolve => {
            const waiting = this.waiters.get(convId) ?? new Set<(ws?: WebSocket) => void>();
            this.waiters.set(convId, waiting);
            const wake = (ws?: WebSocket) => {
                clearTimeout(timeout);
                waiting.delete(wake);
                if (waiting.size === 0) {
                    this.waiters.delete(convId);
                }
                resolve(ws);
            };
            const timeout = setTimeout(wake, this.deliveryWaitMs);
            waiting.add(wake);
        });
    }

    // Sends once and reports what the socket said. A failure is not retried: the peer may have received the frame
    private transmit(ws: WebSocket, convId: string, data: string): Promise<DeliveryResult> {
        return new Promise(resolve => {
            const settle = (err?: Error) => {
                if (err) {
                    this.counters.deliveriesFailed++;
                    this.logger.warn(`Failed to send transcript to conversation ${convId}: ${err.message}`);
                    resolve('send_failed');
                } else {
                    this.counters.deliveriesSent++;
                    resolve('sent');
                }
            };
            try {
                ws.send(data, settle);
            } catch (e: unknown) {
                settle(e instanceof Error ? e : new Error(String(e)));
            }
        });
    }

    // Starts the close handshake and cuts the connection if the peer has not completed it within the grace period
    private closeSocket(ws: WebSocket, code: number, reason: string) {
        if (ws.readyState === WebSocket.CLOSED) {
            return;
        }
        const cutoff = setTimeout(() => ws.terminate(), this.closeGraceMs);
        cutoff.unref();
        ws.once('close', () => clearTimeout(cutoff));
        ws.close(code, reason);
    }

    private startHeartbeat() {
        this.heartbeat = setInterval(() => this.pingClients(), this.heartbeatIntervalMs);
        this.heartbeat.unref();
    }

    // Cuts every open socket that did not answer the previous ping and pings the rest. Browsers answer pings on
    // their own, so a missed pong means the path to the client is gone although the socket still looks open.
    // Sockets already closing are left to their own cutoff.
    private pingClients() {
        for (const ws of this.wss.clients) {
            if (ws.readyState !== WebSocket.OPEN) {
                continue;
            }
            if (!this.alive.has(ws)) {
                this.counters.heartbeatTimeouts++;
                ws.terminate();
                continue;
            }
            this.alive.delete(ws);
            ws.ping();
        }
    }
}
