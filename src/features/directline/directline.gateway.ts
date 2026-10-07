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
import { Transcript } from 'botframework-schema';
import { ConfigService } from '@nestjs/config';
import { DirectlineTokenService } from './dirtectline-token.service';

// RFC 6455 close code: the connection was refused for a policy reason (bad or missing token)
const POLICY_VIOLATION = 1008;

@Injectable()
export class DirectLineGateway implements OnModuleInit, OnModuleDestroy {
    private readonly logger = new Logger(this.constructor.name);
    private wss: WSServer;
    // Conversation id to socket
    private readonly socketMeta = new Map<string, WebSocket>();
    private readonly socketPort: number;

    constructor(
        private readonly directLineTokenService: DirectlineTokenService,
        configService: ConfigService
    ) {
        this.socketPort = Number(configService.get<number>('SOCKET_PORT'));
    }

    onModuleInit() {
        this.wss = new WSServer({ port: this.socketPort });

        this.wss.on('connection', (ws: WebSocket, req: IncomingMessage) => this.handleConnection(ws, req));

        this.wss.on('listening', () => {
            this.logger.log('WebSocket server started');
        });

        this.wss.on('error', (err: Error) => {
            this.logger.error(`WebSocket error ${err}`);
        });
    }

    handleConnection(ws: WebSocket, req: IncomingMessage) {
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
            ws.send(JSON.stringify({ error: e instanceof Error ? e.message : String(e) }));
            ws.close(POLICY_VIOLATION);
            return;
        }

        // A newer socket for the same conversation replaces this one; only remove the entry we own
        this.socketMeta.set(conv, ws);
        this.logger.verbose(`Web-socket connected for conversation ${conv}`);
        ws.on('close', () => {
            if (this.socketMeta.get(conv) === ws) {
                this.socketMeta.delete(conv);
            }
        });
        ws.on('error', (err: Error) => {
            this.logger.error(`WebSocket error ${err}`);
        });
    }

    onModuleDestroy() {
        if (this.wss) {
            this.wss.close();
        }
    }

    async sendToConversation(convId: string, activityPayload: Transcript) {
        // Retry three times (if client is taking long to connect)
        for (let i = 1; i <= 3; i++) {
            const wsConnection = this.socketMeta.get(convId);
            if (wsConnection) {
                // Direct string transmission
                wsConnection.send(JSON.stringify(activityPayload));
                return;
            }
            this.logger.verbose(`Retrying sending to conversation ${convId} (was not registered)`);
            // Exponential retry
            await new Promise(resolve => {
                setTimeout(resolve, 1000 * i);
            });
        }
        this.logger.warn(`Could not send transcript to conversation ${convId}`);
    }
}
