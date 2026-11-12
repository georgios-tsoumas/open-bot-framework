import {
    BadRequestException,
    BeforeApplicationShutdown,
    Inject,
    Injectable,
    Logger,
    OnModuleInit,
    UnauthorizedException
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { IncomingMessage } from 'http';
import Redis from 'ioredis';
import { WebSocket, WebSocketServer } from 'ws';
import { REDIS_SUBSCRIBER } from '../redis/redis.constants';
import { DrainStateService } from '../health/drain-state.service';
import { ActivityStoreService } from './activity-store.service';
import {
    ActivitySetFrame,
    CHANNEL_PREFIX,
    ConversationMessage,
    conversationChannel,
    isWatermark,
    toFrame
} from './conversation-stream.types';
import { DirectlineTokenService } from './dirtectline-token.service';

// RFC 6455 close codes
const GOING_AWAY = 1001; // pod shutting down; DirectLine clients reconnect
const POLICY_VIOLATION = 1008; // bad or missing token
const INTERNAL_ERROR = 1011; // could not replay; the client reconnects and tries again

const STREAM_PATH = /^\/v3\/directline\/conversations\/([^/]+)\/stream$/;

interface SocketState {
    ws: WebSocket;
    /** True while stored activities are being replayed; live messages wait in `queued`. */
    replaying: boolean;
    queued: ConversationMessage[];
}

/**
 * DirectLine stream websockets, served on their own port (SOCKET_PORT).
 *
 * Any replica can receive a bot reply. Replies are stored in Redis and published on the
 * conversation's channel; this pod subscribes to the channels of the conversations whose sockets it
 * holds. On connect it replays stored activities after the client's watermark.
 */
@Injectable()
export class DirectLineGateway implements OnModuleInit, BeforeApplicationShutdown {
    private readonly logger = new Logger(this.constructor.name);
    private wss?: WebSocketServer;
    // Conversation id to socket, for sockets held by this pod
    private readonly sockets = new Map<string, SocketState>();
    private readonly socketPort: number;
    private readonly drainMs: number;

    constructor(
        private readonly directLineTokenService: DirectlineTokenService,
        private readonly activityStore: ActivityStoreService,
        @Inject(REDIS_SUBSCRIBER) private readonly subscriber: Redis,
        private readonly drainState: DrainStateService,
        configService: ConfigService
    ) {
        this.socketPort = Number(configService.get<string>('SOCKET_PORT'));
        this.drainMs = Number(configService.get<string>('SHUTDOWN_DRAIN_MS') ?? 5000);
    }

    onModuleInit() {
        this.subscriber.on('message', (channel: string, message: string) => this.onChannelMessage(channel, message));
        this.wss = new WebSocketServer({
            port: this.socketPort,
            verifyClient: ({ req }: { req: IncomingMessage }) => this.acceptsUpgrade(req)
        });
        this.wss.on('connection', (ws: WebSocket, req: IncomingMessage) => void this.handleConnection(ws, req));
        this.wss.on('listening', () => {
            this.logger.log(`WebSocket server listening on ${this.socketPort}`);
        });
        this.wss.on('error', (err: Error) => {
            this.logger.error(`WebSocket error ${err}`);
        });
    }

    /** Refuse upgrades to other paths, and new sockets while the pod drains for shutdown. */
    acceptsUpgrade(req: IncomingMessage): boolean {
        const pathname = new URL(req.url ?? '', 'http://obf').pathname;
        return !this.drainState.isDraining() && STREAM_PATH.test(pathname);
    }

    async handleConnection(ws: WebSocket, req: IncomingMessage): Promise<void> {
        let conv: string;
        let afterSeq: number;
        try {
            const parsedUrl = new URL(`wss://server${req?.url ?? ''}`);
            const token = parsedUrl.searchParams.get('t');
            if (token === null) {
                throw new UnauthorizedException('Missing token');
            }
            const directLineTokenPayload = this.directLineTokenService.verifyDirectLineToken(token);
            const match = parsedUrl.pathname.match(STREAM_PATH);
            if (!match || match[1] !== directLineTokenPayload.conv) {
                throw new BadRequestException('Erroneous link');
            }
            conv = directLineTokenPayload.conv;
            // No watermark: replay everything stored
            const watermark = parsedUrl.searchParams.get('watermark');
            afterSeq = isWatermark(watermark) ? Number(watermark) : -1;
        } catch (e: unknown) {
            ws.send(JSON.stringify({ error: e instanceof Error ? e.message : String(e) }));
            ws.close(POLICY_VIOLATION);
            return;
        }

        // A newer socket for the same conversation replaces this one; only remove the entry we own.
        // The channel subscription belongs to the map entry, so a replacement keeps it.
        const subscribed = this.sockets.has(conv);
        const state: SocketState = { ws, replaying: true, queued: [] };
        this.sockets.set(conv, state);
        this.logger.verbose(`Web-socket connected for conversation ${conv}`);
        ws.on('close', () => this.onClose(conv, ws));
        ws.on('error', (err: Error) => {
            this.logger.error(`WebSocket error ${err}`);
        });

        // Seqs sent in the replay, so a queued live copy of the same activity is not sent twice
        const replayed = new Set<number>();
        try {
            if (!subscribed) {
                await this.subscriber.subscribe(conversationChannel(conv));
            }
            const stored = await this.activityStore.after(conv, afterSeq);
            if (stored.length > 0) {
                this.send(ws, {
                    activities: stored.map(s => s.activity),
                    watermark: String(stored[stored.length - 1].seq)
                });
                stored.forEach(s => replayed.add(s.seq));
            }
        } catch (e: unknown) {
            this.logger.error(`Replay failed for conversation ${conv}: ${String(e)}`);
            ws.close(INTERNAL_ERROR);
        } finally {
            state.replaying = false;
            for (const message of state.queued) {
                if (message.seq === null || !replayed.has(message.seq)) {
                    this.send(ws, toFrame(message));
                }
            }
            state.queued = [];
        }
        // The socket may have closed while we were subscribing; drop a subscription nobody uses
        if (!this.sockets.has(conv)) {
            await this.unsubscribe(conv);
        }
    }

    onChannelMessage(channel: string, raw: string) {
        if (!channel.startsWith(CHANNEL_PREFIX)) {
            return;
        }
        const state = this.sockets.get(channel.slice(CHANNEL_PREFIX.length));
        if (!state) {
            return;
        }
        let message: ConversationMessage;
        try {
            message = JSON.parse(raw) as ConversationMessage;
        } catch {
            this.logger.warn(`Dropping malformed message on ${channel}`);
            return;
        }
        if (state.replaying) {
            state.queued.push(message);
            return;
        }
        this.send(state.ws, toFrame(message));
    }

    /**
     * Rolling deploy: stop taking traffic, give k8s time to remove this pod from endpoints, then close
     * sockets with 1001. DirectLine clients reconnect to another pod and replay from the store.
     * Runs before the HTTP server and the Redis clients close.
     */
    async beforeApplicationShutdown() {
        this.drainState.start();
        this.logger.log(`Draining for ${this.drainMs} ms`);
        await new Promise(resolve => setTimeout(resolve, this.drainMs));
        for (const { ws } of this.sockets.values()) {
            ws.close(GOING_AWAY);
        }
        this.sockets.clear();
        await this.subscriber.unsubscribe().catch((e: unknown) => this.logger.warn(`Unsubscribe failed: ${String(e)}`));
        this.wss?.close();
    }

    private onClose(conv: string, ws: WebSocket) {
        if (this.sockets.get(conv)?.ws !== ws) {
            return;
        }
        this.sockets.delete(conv);
        void this.unsubscribe(conv);
    }

    private async unsubscribe(conv: string) {
        try {
            await this.subscriber.unsubscribe(conversationChannel(conv));
        } catch (e: unknown) {
            this.logger.warn(`Unsubscribe failed for conversation ${conv}: ${String(e)}`);
        }
    }

    private send(ws: WebSocket, frame: ActivitySetFrame) {
        if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify(frame));
        }
    }
}
