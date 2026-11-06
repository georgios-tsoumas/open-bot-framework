import { EventEmitter, once } from 'events';
import { IncomingMessage } from 'http';
import { AddressInfo, createServer } from 'net';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Activity, Transcript } from 'botframework-schema';
import { ClientOptions, WebSocket } from 'ws';
import { WebChatService } from '../channels/webchat/webchat.service';
import { DirectlineTokenService } from './dirtectline-token.service';
import { DeliveryResult, DirectLineGateway } from './directline.gateway';

class FakeSocket extends EventEmitter {
    readyState: number = WebSocket.OPEN;
    send = jest.fn((_data: string, cb?: (err?: Error) => void) => cb?.());
    close = jest.fn();
    terminate = jest.fn();
    ping = jest.fn();
}

const CLOSE_GRACE_MS = 5000;
const config = (values: Record<string, unknown> = {}) =>
    ({ get: (key: string) => values[key] }) as unknown as ConfigService;
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
// Polls an assertion until it passes or the deadline is reached (socket close events settle a tick apart)
const eventually = async (check: () => void, timeoutMs = 1000) => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        try {
            check();
            return;
        } catch (e) {
            if (Date.now() > deadline) throw e;
        }
        await sleep(10);
    }
};

describe('DirectLineGateway', () => {
    const configService = config();
    const tokenService = new DirectlineTokenService(
        {} as WebChatService,
        configService,
        new JwtService({ secret: 'test-secret' })
    );
    const token = tokenService.createToken({ bot: 'bot', site: 'site1', conv: 'conv1' }, 60);
    const streamPath = (t?: string) =>
        `/v3/directline/conversations/conv1/stream?watermark=-${t === undefined ? '' : `&t=${t}`}`;

    let gateway: DirectLineGateway;
    const connect = (url: string) => {
        const ws = new FakeSocket();
        gateway.handleConnection(ws as unknown as WebSocket, { url } as IncomingMessage);
        return ws;
    };
    const registered = () => gateway['socketMeta'];

    beforeEach(() => {
        gateway = new DirectLineGateway(tokenService, config({ SOCKET_CLOSE_GRACE_MS: CLOSE_GRACE_MS }));
    });

    it('registers a socket with a valid token', () => {
        const ws = connect(streamPath(token));
        expect(ws.close).not.toHaveBeenCalled();
        expect(registered().get('conv1')).toBe(ws);
    });

    it.each([
        ['no token', streamPath()],
        ['a bad token', streamPath('not-a-jwt')],
        ['a token for another conversation', streamPath(token).replace('conv1', 'conv2')]
    ])('closes a socket with %s', (_label, url) => {
        const ws = connect(url);
        expect(ws.close).toHaveBeenCalledWith(1008, expect.any(String));
        expect(registered().size).toBe(0);
    });

    it('forgets a socket once it closes', () => {
        const ws = connect(streamPath(token));
        ws.emit('close');
        expect(registered().has('conv1')).toBe(false);
    });

    it('keeps the newer socket when an older one for the same conversation closes', () => {
        const older = connect(streamPath(token));
        const newer = connect(streamPath(token));
        older.emit('close');
        expect(registered().get('conv1')).toBe(newer);
    });

    describe('replacing a socket', () => {
        beforeEach(() => jest.useFakeTimers());
        afterEach(() => jest.useRealTimers());

        it('closes the older socket for the same conversation', () => {
            const older = connect(streamPath(token));
            const newer = connect(streamPath(token));
            expect(older.close).toHaveBeenCalledWith(1000, expect.any(String));
            expect(newer.close).not.toHaveBeenCalled();
            expect(registered().get('conv1')).toBe(newer);
        });

        it('cuts the older socket if it does not finish closing within the grace period', () => {
            const older = connect(streamPath(token));
            connect(streamPath(token));
            jest.advanceTimersByTime(CLOSE_GRACE_MS - 1);
            expect(older.terminate).not.toHaveBeenCalled();
            jest.advanceTimersByTime(1);
            expect(older.terminate).toHaveBeenCalled();
        });

        it('leaves the older socket alone once it has closed', () => {
            const older = connect(streamPath(token));
            connect(streamPath(token));
            older.emit('close');
            jest.advanceTimersByTime(CLOSE_GRACE_MS);
            expect(older.terminate).not.toHaveBeenCalled();
        });
    });

    describe('sendToConversation', () => {
        const transcript: Transcript = { activities: [] };
        const send = () => gateway.sendToConversation('conv1', transcript);
        // Captures the outcome once settled, so a test can assert that delivery is still waiting
        const track = (pending: Promise<DeliveryResult>) => {
            const outcome: { result?: DeliveryResult } = {};
            void pending.then(result => (outcome.result = result));
            return outcome;
        };

        beforeEach(() => jest.useFakeTimers());
        afterEach(() => jest.useRealTimers());

        it('sends once, immediately, to an open socket', async () => {
            const ws = connect(streamPath(token));
            await expect(send()).resolves.toBe('sent');
            expect(ws.send).toHaveBeenCalledTimes(1);
            expect(ws.send.mock.calls[0][0]).toBe(JSON.stringify(transcript));
            expect(gateway.stats().counters).toMatchObject({ deliveriesSent: 1, deliveriesWaited: 0 });
        });

        it.each([0, 500, 2999, 5999])('delivers the moment a socket connects, %d ms later', async delay => {
            const pending = send();
            await jest.advanceTimersByTimeAsync(delay);
            const ws = connect(streamPath(token));
            // No further time passes: the registration itself wakes the waiting delivery
            await expect(pending).resolves.toBe('sent');
            expect(ws.send).toHaveBeenCalledTimes(1);
            expect(gateway.stats().counters).toMatchObject({ deliveriesSent: 1, deliveriesWaited: 1 });
        });

        it('wakes every delivery waiting for the same conversation, in order', async () => {
            const first = gateway.sendToConversation('conv1', { activities: [{ id: 'a' } as Activity] });
            const second = gateway.sendToConversation('conv1', { activities: [{ id: 'b' } as Activity] });
            await jest.advanceTimersByTimeAsync(100);
            const ws = connect(streamPath(token));
            await expect(Promise.all([first, second])).resolves.toEqual(['sent', 'sent']);
            const sentIds = ws.send.mock.calls.map(([data]) => (JSON.parse(data) as Transcript).activities[0].id);
            expect(sentIds).toEqual(['a', 'b']);
            expect(gateway['waiters'].size).toBe(0);
        });

        it('gives up after the delivery wait when no socket connects', async () => {
            const outcome = track(send());
            await jest.advanceTimersByTimeAsync(5999);
            expect(outcome.result).toBeUndefined();
            expect(gateway.stats().pendingDeliveries).toBe(1);
            await jest.advanceTimersByTimeAsync(1);
            expect(outcome.result).toBe('no_open_socket');
            expect(gateway.stats()).toMatchObject({
                pendingDeliveries: 0,
                counters: { deliveriesNoOpenSocket: 1, deliveriesWaited: 1 }
            });
            expect(gateway['waiters'].size).toBe(0);
        });

        it('does not send to a socket that connects after the delivery wait', async () => {
            const pending = send();
            await jest.advanceTimersByTimeAsync(6000);
            await expect(pending).resolves.toBe('no_open_socket');
            const late = connect(streamPath(token));
            expect(late.send).not.toHaveBeenCalled();
        });

        it('releases waiting deliveries on shutdown', async () => {
            const pending = send();
            await gateway.onModuleDestroy();
            await expect(pending).resolves.toBe('no_open_socket');
            expect(gateway['waiters'].size).toBe(0);
        });

        it.each([
            ['connecting', WebSocket.CONNECTING],
            ['closing', WebSocket.CLOSING],
            ['closed', WebSocket.CLOSED]
        ])('does not send to a registered socket that is %s', async (_label, readyState) => {
            const ws = connect(streamPath(token));
            ws.readyState = readyState;
            const pending = send();
            await jest.advanceTimersByTimeAsync(6000);
            await expect(pending).resolves.toBe('no_open_socket');
            expect(ws.send).not.toHaveBeenCalled();
        });

        it('delivers to the replacement of a closing socket', async () => {
            const stale = connect(streamPath(token));
            stale.readyState = WebSocket.CLOSING;
            const pending = send();
            await jest.advanceTimersByTimeAsync(1000);
            const fresh = connect(streamPath(token));
            await expect(pending).resolves.toBe('sent');
            expect(stale.send).not.toHaveBeenCalled();
            expect(fresh.send).toHaveBeenCalledTimes(1);
        });

        it('reports a failed send and does not send again', async () => {
            const ws = connect(streamPath(token));
            ws.send.mockImplementation((_data, cb) => cb?.(new Error('write EPIPE')));
            await expect(send()).resolves.toBe('send_failed');
            expect(ws.send).toHaveBeenCalledTimes(1);
            expect(gateway.stats().counters).toMatchObject({ deliveriesFailed: 1, deliveriesSent: 0 });
        });
    });

    describe('on a live server', () => {
        const HEARTBEAT_MS = 100;
        const GRACE_MS = 300;
        let live: DirectLineGateway;
        const clients: WebSocket[] = [];

        beforeEach(async () => {
            live = new DirectLineGateway(
                tokenService,
                config({ SOCKET_PORT: 0, SOCKET_HEARTBEAT_INTERVAL_MS: HEARTBEAT_MS, SOCKET_CLOSE_GRACE_MS: GRACE_MS })
            );
            await live.onModuleInit();
        });

        afterEach(async () => {
            clients.splice(0).forEach(client => client.terminate());
            await live.onModuleDestroy();
        });

        const port = () => (live['wss'].address() as AddressInfo).port;
        const dial = (t = token, options?: ClientOptions) => {
            const client = new WebSocket(`ws://127.0.0.1:${port()}${streamPath(t)}`, options);
            client.on('error', () => undefined);
            clients.push(client);
            return client;
        };
        const open = async (t = token, options?: ClientOptions) => {
            const client = dial(t, options);
            await once(client, 'open');
            return client;
        };
        const closed = (client: WebSocket) => new Promise<number>(resolve => client.once('close', resolve));

        it('is listening once initialised', () => {
            expect(live.stats()).toMatchObject({ listening: true, clients: 0, conversations: 0 });
        });

        it('fails to start when the port is taken', async () => {
            const blocker = createServer().listen(0);
            await once(blocker, 'listening');
            const other = new DirectLineGateway(
                tokenService,
                config({ SOCKET_PORT: (blocker.address() as AddressInfo).port })
            );
            await expect(other.onModuleInit()).rejects.toMatchObject({ code: 'EADDRINUSE' });
            expect(other.stats().listening).toBe(false);
            blocker.close();
        });

        it('registers a client that presents a valid token', async () => {
            await open();
            expect(live.stats()).toMatchObject({ clients: 1, conversations: 1 });
        });

        it('delivers a transcript to a client that connects after the bot answered', async () => {
            const transcript: Transcript = { activities: [{ id: 'conv1|0000001', type: 'message' } as Activity] };
            const pending = live.sendToConversation('conv1', transcript);
            const client = dial();
            // Listen before 'open': delivery is immediate, so the frame can arrive in the same chunk as the handshake
            const frame = new Promise<string>(resolve =>
                client.once('message', data => resolve((data as Buffer).toString()))
            );
            expect(JSON.parse(await frame)).toEqual(transcript);
            await expect(pending).resolves.toBe('sent');
            expect(live.stats().counters).toMatchObject({ deliveriesSent: 1, deliveriesWaited: 1 });
        });

        it('refuses a client with a bad token', async () => {
            const client = await open('not-a-jwt');
            expect(await closed(client)).toBe(1008);
            await eventually(() => expect(live.stats()).toMatchObject({ clients: 0, conversations: 0 }));
        });

        it('closes a replaced socket normally and keeps the newer one', async () => {
            const older = await open();
            const olderClosed = closed(older);
            const newer = await open();
            expect(await olderClosed).toBe(1000);
            expect(newer.readyState).toBe(WebSocket.OPEN);
            await eventually(() => expect(live.stats()).toMatchObject({ clients: 1, conversations: 1 }));
            expect(live.stats().counters).toMatchObject({ connectionsReplaced: 1, heartbeatTimeouts: 0 });
        });

        it('drops a client that stops answering pings', async () => {
            const silent = await open(token, { autoPong: false });
            await closed(silent);
            await eventually(() => expect(live.stats()).toMatchObject({ clients: 0, conversations: 0 }));
            expect(live.stats().counters.heartbeatTimeouts).toBe(1);
        });

        it('keeps a responsive client across several heartbeat cycles', async () => {
            const client = await open();
            await sleep(HEARTBEAT_MS * 4);
            expect(client.readyState).toBe(WebSocket.OPEN);
            expect(live.stats()).toMatchObject({ clients: 1, counters: { heartbeatTimeouts: 0 } });
        });

        it('tells clients it is going away on shutdown and stops listening', async () => {
            const client = await open();
            const code = closed(client);
            await live.onModuleDestroy();
            expect(await code).toBe(1001);
            expect(live.stats()).toMatchObject({ listening: false, clients: 0, conversations: 0 });
        });
    });
});
