import { EventEmitter } from 'events';
import { IncomingMessage } from 'http';
import { AddressInfo, createServer, Server } from 'net';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Activity } from 'botframework-schema';
import Redis from 'ioredis';
import { WebSocket } from 'ws';
import { WebChatService } from '../channels/webchat/webchat.service';
import { DrainStateService } from '../health/drain-state.service';
import { ActivityStoreService } from './activity-store.service';
import { StoredActivity } from './conversation-stream.types';
import { DirectlineTokenService } from './dirtectline-token.service';
import { DirectLineGateway } from './directline.gateway';

class FakeSocket extends EventEmitter {
    readyState: number = WebSocket.OPEN;
    send = jest.fn();
    close = jest.fn();
    frames = () => this.send.mock.calls.map(([raw]) => JSON.parse(raw as string) as Record<string, unknown>);
}

const activity = (seq: number, type = 'message') => ({ id: `conv1|${seq}`, type }) as Activity;
const stored = (seq: number): StoredActivity => ({ seq, activity: activity(seq) });
const message = (seq: number | null, type = 'message') => JSON.stringify({ seq, activity: activity(seq ?? -1, type) });

describe('DirectLineGateway', () => {
    const configService = { get: () => undefined } as unknown as ConfigService;
    const tokenService = new DirectlineTokenService(
        {} as WebChatService,
        configService,
        new JwtService({ secret: 'test-secret' })
    );
    const token = tokenService.createToken({ bot: 'bot', site: 'site1', conv: 'conv1' }, 60);
    const streamPath = (t?: string, watermark = '-') =>
        `/v3/directline/conversations/conv1/stream?watermark=${watermark}${t === undefined ? '' : `&t=${t}`}`;

    let gateway: DirectLineGateway;
    let subscriber: { subscribe: jest.Mock; unsubscribe: jest.Mock; on: jest.Mock };
    let store: { after: jest.Mock };
    let drainState: DrainStateService;

    const connect = async (url: string) => {
        const ws = new FakeSocket();
        await gateway.handleConnection(ws as unknown as WebSocket, { url } as IncomingMessage);
        return ws;
    };
    const registered = () => gateway['sockets'];

    beforeEach(() => {
        subscriber = {
            subscribe: jest.fn().mockResolvedValue(1),
            unsubscribe: jest.fn().mockResolvedValue(0),
            on: jest.fn()
        };
        store = { after: jest.fn().mockResolvedValue([]) };
        drainState = new DrainStateService();
        gateway = new DirectLineGateway(
            tokenService,
            store as unknown as ActivityStoreService,
            subscriber as unknown as Redis,
            drainState,
            configService
        );
    });

    describe('onModuleInit', () => {
        const listen = (server: Server) =>
            new Promise<number>(resolve =>
                server.listen(0, '0.0.0.0', () => resolve((server.address() as AddressInfo).port))
            );
        const gatewayOnPort = (port: number) =>
            new DirectLineGateway(
                tokenService,
                store as unknown as ActivityStoreService,
                subscriber as unknown as Redis,
                drainState,
                { get: (key: string) => (key === 'SOCKET_PORT' ? String(port) : undefined) } as unknown as ConfigService
            );

        it('fails startup when SOCKET_PORT is already taken', async () => {
            const blocker = createServer();
            const port = await listen(blocker);
            try {
                await expect(gatewayOnPort(port).onModuleInit()).rejects.toThrow(
                    `WebSocket server cannot listen on ${port}`
                );
            } finally {
                blocker.close();
            }
        });

        it('starts listening on SOCKET_PORT', async () => {
            const probe = createServer();
            const port = await listen(probe);
            await new Promise(resolve => probe.close(resolve));
            const started = gatewayOnPort(port);
            await started.onModuleInit();
            try {
                expect((started['wss']?.address() as AddressInfo).port).toBe(port);
            } finally {
                started['wss']?.close();
            }
        });
    });

    it('registers a socket with a valid token and subscribes to its channel', async () => {
        const ws = await connect(streamPath(token));
        expect(ws.close).not.toHaveBeenCalled();
        expect(registered().get('conv1')?.ws).toBe(ws);
        expect(subscriber.subscribe).toHaveBeenCalledWith('obf:conv:conv1');
    });

    it.each([
        ['no token', streamPath()],
        ['a bad token', streamPath('not-a-jwt')],
        ['a token for another conversation', streamPath(token).replace('conv1', 'conv2')]
    ])('closes a socket with %s', async (_label, url) => {
        const ws = await connect(url);
        expect(ws.close).toHaveBeenCalledWith(1008);
        expect(registered().size).toBe(0);
        expect(subscriber.subscribe).not.toHaveBeenCalled();
    });

    it('replays activities after the client watermark in one frame', async () => {
        store.after.mockResolvedValueOnce([stored(6), stored(7)]);
        const ws = await connect(streamPath(token, '5'));
        expect(store.after).toHaveBeenCalledWith('conv1', 5);
        expect(ws.frames()).toEqual([{ activities: [activity(6), activity(7)], watermark: '7' }]);
    });

    it.each(['-', ''])('replays everything stored when the watermark is %p', async watermark => {
        await connect(streamPath(token, watermark));
        expect(store.after).toHaveBeenCalledWith('conv1', -1);
    });

    it('sends nothing on connect when nothing is stored', async () => {
        const ws = await connect(streamPath(token));
        expect(ws.send).not.toHaveBeenCalled();
    });

    it('holds live messages during replay and skips the ones already replayed', async () => {
        let finishReplay: (value: StoredActivity[]) => void = () => undefined;
        store.after.mockReturnValueOnce(new Promise<StoredActivity[]>(resolve => (finishReplay = resolve)));
        const ws = new FakeSocket();
        const connecting = gateway.handleConnection(
            ws as unknown as WebSocket,
            { url: streamPath(token) } as IncomingMessage
        );
        await Promise.resolve(); // let subscribe finish so the socket is registered and replaying

        gateway.onChannelMessage('obf:conv:conv1', message(3));
        gateway.onChannelMessage('obf:conv:conv1', message(4));
        expect(ws.send).not.toHaveBeenCalled();

        finishReplay([stored(2), stored(3)]);
        await connecting;
        expect(ws.frames()).toEqual([
            { activities: [activity(2), activity(3)], watermark: '3' },
            { activities: [activity(4)], watermark: '4' }
        ]);
    });

    it('sends live messages with a watermark, typing without one', async () => {
        const ws = await connect(streamPath(token));
        gateway.onChannelMessage('obf:conv:conv1', message(9));
        gateway.onChannelMessage('obf:conv:conv1', message(null, 'typing'));
        expect(ws.frames()).toEqual([
            { activities: [activity(9)], watermark: '9' },
            { activities: [activity(-1, 'typing')] }
        ]);
    });

    it('ignores messages for conversations it does not hold, and malformed ones', async () => {
        const ws = await connect(streamPath(token));
        gateway.onChannelMessage('obf:conv:other', message(1));
        gateway.onChannelMessage('obf:conv:conv1', 'not json');
        expect(ws.send).not.toHaveBeenCalled();
    });

    it('does not send to a socket that is no longer open', async () => {
        const ws = await connect(streamPath(token));
        ws.readyState = WebSocket.CLOSING;
        gateway.onChannelMessage('obf:conv:conv1', message(1));
        expect(ws.send).not.toHaveBeenCalled();
    });

    it('closes with 1011 when the replay fails', async () => {
        store.after.mockRejectedValueOnce(new Error('redis down'));
        const ws = await connect(streamPath(token));
        expect(ws.close).toHaveBeenCalledWith(1011);
    });

    it('forgets the socket and unsubscribes once it closes', async () => {
        const ws = await connect(streamPath(token));
        ws.emit('close');
        expect(registered().has('conv1')).toBe(false);
        expect(subscriber.unsubscribe).toHaveBeenCalledWith('obf:conv:conv1');
    });

    it('keeps the newer socket and the subscription when an older one closes', async () => {
        const older = await connect(streamPath(token));
        const newer = await connect(streamPath(token));
        older.emit('close');
        expect(registered().get('conv1')?.ws).toBe(newer);
        expect(subscriber.subscribe).toHaveBeenCalledTimes(1);
        expect(subscriber.unsubscribe).not.toHaveBeenCalled();
    });

    it('drops the subscription when the socket closed while subscribing', async () => {
        const ws = new FakeSocket();
        subscriber.subscribe.mockImplementationOnce(() => {
            ws.emit('close');
            return Promise.resolve(1);
        });
        await gateway.handleConnection(ws as unknown as WebSocket, { url: streamPath(token) } as IncomingMessage);
        expect(registered().has('conv1')).toBe(false);
        expect(subscriber.unsubscribe).toHaveBeenCalledWith('obf:conv:conv1');
    });

    describe('acceptsUpgrade', () => {
        const accepts = (url: string) => gateway.acceptsUpgrade({ url } as IncomingMessage);

        it('accepts the stream path', () => {
            expect(accepts(streamPath(token))).toBe(true);
        });

        it('refuses other paths', () => {
            expect(accepts('/v3/directline/conversations')).toBe(false);
        });

        it('refuses new sockets while draining', () => {
            drainState.start();
            expect(accepts(streamPath(token))).toBe(false);
        });
    });

    it('on shutdown drains, then closes sockets with 1001 and unsubscribes', async () => {
        jest.useFakeTimers();
        try {
            const ws = await connect(streamPath(token));
            const shutdown = gateway.beforeApplicationShutdown();
            expect(drainState.isDraining()).toBe(true);
            expect(ws.close).not.toHaveBeenCalled();
            await jest.advanceTimersByTimeAsync(5000);
            await shutdown;
            expect(ws.close).toHaveBeenCalledWith(1001);
            expect(subscriber.unsubscribe).toHaveBeenCalledWith();
            expect(registered().size).toBe(0);
        } finally {
            jest.useRealTimers();
        }
    });
});
