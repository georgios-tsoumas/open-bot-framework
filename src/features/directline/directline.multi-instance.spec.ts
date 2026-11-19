import { HttpModule } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { Activity } from 'botframework-schema';
import { randomUUID } from 'crypto';
import { createServer, Server } from 'http';
import { createRequire } from 'module';
import { AddressInfo } from 'net';
import Redis from 'ioredis';
import { WebSocket, WebSocketServer } from 'ws';
import { RedisAtomicOperationsManager } from '../atomicity/atomic-operations-manager.redis';
import { AtomicOperationsService } from '../atomicity/atomic-operations.service';
import { AuthorizationService } from '../authorization/authorization.service';
import { WebChatService } from '../channels/webchat/webchat.service';
import { DrainStateService } from '../health/drain-state.service';
import { OpenBotService } from '../openbot/openbot.service';
import { OpenBotSecretService } from '../openbotsecret/openbotsecret.service';
import { REDIS_CLIENT, REDIS_SUBSCRIBER } from '../redis/redis.constants';
import { StorageService } from '../storage/storage.service';
import { ActivityStoreService } from './activity-store.service';
import { ConversationPublisher } from './conversation-publisher.service';
import { ActivitySetFrame } from './conversation-stream.types';
import { DirectlineAltController } from './directline-alt.controller';
import { DirectlineConversationService } from './directline-conversation.service';
import { DirectlineController } from './directline.controller';
import { DirectLineGateway } from './directline.gateway';
import { DirectlineTokenService } from './dirtectline-token.service';

// Opt in with a local development Redis. Only this run's uniquely prefixed keys are removed.
const redisUri = process.env.OBF_TEST_REDIS_URI;
const integration = redisUri ? describe : describe.skip;

integration('DirectLine across two HTTP/WebSocket replicas and real Redis', () => {
    const prefix = `obf-e2e-${randomUUID()}`;
    const jwt = new JwtService({ secret: randomUUID() });
    const clients: Redis[] = [];
    const apps: NestFastifyApplication[] = [];
    const sockets: WebSocket[] = [];
    const urls: string[] = [];
    let bot: Server;
    let botUrl: string;
    let botToken: string;
    let releaseBot: (() => void) | undefined;

    const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
    const request = (replica: number, path: string, token: string, body?: unknown) =>
        fetch(`${urls[replica]}${path}`, {
            method: body === undefined ? 'GET' : 'POST',
            headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
            ...(body === undefined ? {} : { body: JSON.stringify(body) })
        });
    const botPost = (replica: number, conv: string, body: unknown) =>
        request(replica, `/v3/conversations/${conv}/activities`, botToken, body);
    const tokenFor = (conv: string) =>
        apps[0].get(DirectlineTokenService).createToken({ bot: 'test-bot', site: 'test-site', conv }, 300);

    const stream = async (replica: number, conv: string, token: string, watermark = '-') => {
        const response = await request(
            replica,
            `/v3/directline/conversations/${conv}?watermark=${encodeURIComponent(watermark)}`,
            token
        );
        expect(response.status).toBe(200);
        const metadata = (await response.json()) as { streamUrl: string };
        const ws = new WebSocket(metadata.streamUrl);
        sockets.push(ws);
        const frames: ActivitySetFrame[] = [];
        ws.on('message', (raw: Buffer) => frames.push(JSON.parse(raw.toString()) as ActivitySetFrame));
        await new Promise<void>((resolve, reject) => {
            ws.once('open', resolve);
            ws.once('error', reject);
        });
        return {
            ws,
            frames,
            activities: () => frames.flatMap(frame => frame.activities),
            waitFor: async (predicate: (frames: ActivitySetFrame[]) => boolean) => {
                const deadline = Date.now() + 2500;
                while (!predicate(frames) && Date.now() < deadline) {
                    await delay(10);
                }
                expect(predicate(frames)).toBe(true);
            }
        };
    };
    const close = (ws: WebSocket) =>
        new Promise<void>(resolve => {
            ws.once('close', () => resolve());
            ws.close();
        });

    beforeAll(async () => {
        botToken = jwt.sign({ sub: 'test-bot-credential' }, { expiresIn: 300 });
        bot = createServer((req, res) => {
            void (async () => {
                const chunks: Buffer[] = [];
                for await (const chunk of req) {
                    chunks.push(Buffer.from(chunk as Uint8Array));
                }
                const activity = JSON.parse(Buffer.concat(chunks).toString()) as Activity;
                const released = new Promise<void>(resolve => (releaseBot = resolve));
                const reply = await botPost(1, activity.conversation.id, { type: 'message', text: 'bot-before-echo' });
                if (reply.status !== 200) {
                    throw new Error(`Bot reply HTTP ${reply.status}`);
                }
                await released;
                res.writeHead(200).end('{}');
            })().catch((error: unknown) => {
                res.writeHead(500).end(String(error));
            });
        });
        await new Promise<void>(resolve => bot.listen(0, '127.0.0.1', resolve));
        botUrl = `http://127.0.0.1:${(bot.address() as AddressInfo).port}`;

        for (let replica = 0; replica < 2; replica++) {
            const redis = new Redis(redisUri!, { lazyConnect: true });
            const subscriber = new Redis(redisUri!, { lazyConnect: true });
            clients.push(redis, subscriber);
            await Promise.all([redis.connect(), subscriber.connect()]);
            const config = new ConfigService({
                SOCKET_PORT: '0',
                SHUTDOWN_DRAIN_MS: '0',
                DIRECTLINE_HOST: 'http://127.0.0.1',
                DIRECTLINE_SOCKET_URL: 'ws://127.0.0.1'
            });
            const module = await Test.createTestingModule({
                imports: [HttpModule],
                controllers: [DirectlineController, DirectlineAltController],
                providers: [
                    DirectlineConversationService,
                    DirectlineTokenService,
                    DirectLineGateway,
                    ActivityStoreService,
                    ConversationPublisher,
                    AtomicOperationsService,
                    AuthorizationService,
                    DrainStateService,
                    { provide: ConfigService, useValue: config },
                    { provide: JwtService, useValue: jwt },
                    { provide: REDIS_CLIENT, useValue: redis },
                    { provide: REDIS_SUBSCRIBER, useValue: subscriber },
                    { provide: 'ATOMIC_OPERATIONS_PROVIDER', useValue: new RedisAtomicOperationsManager(redis) },
                    { provide: OpenBotService, useValue: { findByHandleCached: () => ({ endpoint: botUrl }) } },
                    {
                        provide: OpenBotSecretService,
                        useValue: { findValidByIdCached: () => ({ id: 'test-bot-credential' }) }
                    },
                    { provide: WebChatService, useValue: {} },
                    { provide: StorageService, useValue: {} }
                ]
            }).compile();
            const app = module.createNestApplication<NestFastifyApplication>(new FastifyAdapter(), { logger: false });
            apps.push(app);
            await app.listen(0, '127.0.0.1');
            urls.push(await app.getUrl());
            const gateway = app.get(DirectLineGateway);
            const wss = (gateway as unknown as { wss: WebSocketServer }).wss;
            // The production service captures its socket URL in its constructor; resolve port 0 now.
            Object.defineProperty(app.get(DirectlineConversationService), 'socketUrl', {
                value: `ws://127.0.0.1:${(wss.address() as AddressInfo).port}`
            });
        }
    }, 15000);

    afterEach(() => {
        releaseBot?.();
        releaseBot = undefined;
    });

    afterAll(async () => {
        releaseBot?.();
        sockets.forEach(ws => ws.terminate());
        await Promise.all(apps.map(app => app.close()));
        if (bot) {
            await new Promise<void>(resolve => bot.close(() => resolve()));
        }
        if (clients[0]?.status === 'ready') {
            let cursor = '0';
            do {
                const [next, keys] = await clients[0].scan(cursor, 'MATCH', `*${prefix}*`, 'COUNT', 100);
                cursor = next;
                if (keys.length) {
                    await clients[0].del(...keys);
                }
            } while (cursor !== '0');
        }
        await Promise.all(clients.map(client => client.quit()));
    }, 15000);

    it('replays a lower-ID user echo exactly once after disconnecting during the bot turn', async () => {
        const conv = `${prefix}-late-echo`;
        const token = tokenFor(conv);
        const first = await stream(0, conv, token);
        const posting = request(0, `/v3/directline/conversations/${conv}/activities`, token, {
            type: 'message',
            text: 'user-before-bot'
        });
        try {
            await first.waitFor(frames =>
                frames.some(frame => frame.activities.some(a => a.text === 'bot-before-echo'))
            );
            const watermark = first.frames.at(-1)!.watermark!;
            await close(first.ws);
            releaseBot!();
            const response = await posting;
            expect(response.status).toBe(200);
            const echo = (await response.json()) as { id: string };
            expect(Number(echo.id.split('|')[1])).toBeLessThan(Number(first.activities()[0].id!.split('|')[1]));
            const resumed = await stream(1, conv, token, watermark);
            await resumed.waitFor(frames => frames.some(frame => frame.activities.some(a => a.id === echo.id)));
            await delay(100);
            expect(resumed.activities().map(a => a.id)).toEqual([echo.id]);
            expect(watermark).toMatch(/^v2:\d+-\d+$/);
            const finalWatermark = resumed.frames.at(-1)!.watermark!;
            await close(resumed.ws);
            const again = await stream(0, conv, token, finalWatermark);
            await delay(100);
            expect(again.activities()).toEqual([]);
        } finally {
            releaseBot?.();
            await posting;
        }
    }, 10000);

    it('delivers concurrent cross-replica publications once with ordered cursors and preserves typing and arrays', async () => {
        const conv = `${prefix}-concurrent`;
        const token = tokenFor(conv);
        const live = await stream(0, conv, token);
        const attachments = [
            { contentType: 'application/vnd.microsoft.card.adaptive', content: { body: [], actions: [] } }
        ];
        const responses = await Promise.all(
            Array.from({ length: 12 }, (_, i) =>
                botPost(i % 2, conv, { type: 'message', text: `reply-${i}`, attachments })
            )
        );
        expect(responses.map(response => response.status)).toEqual(Array(12).fill(200));
        const ids = await Promise.all(responses.map(async response => ((await response.json()) as { id: string }).id));
        await live.waitFor(frames => frames.flatMap(frame => frame.activities).length >= 12);
        expect(
            live
                .activities()
                .map(a => a.id)
                .sort()
        ).toEqual([...ids].sort());
        expect(live.activities().every(a => JSON.stringify(a.attachments) === JSON.stringify(attachments))).toBe(true);
        const cursors = live.frames.map(frame => frame.watermark!);
        expect(cursors.every(cursor => /^v2:\d+-\d+$/.test(cursor))).toBe(true);
        const ordered = [...cursors].sort((a, b) => {
            const [am, as] = a.slice(3).split('-').map(BigInt);
            const [bm, bs] = b.slice(3).split('-').map(BigInt);
            return am === bm ? (as < bs ? -1 : as > bs ? 1 : 0) : am < bm ? -1 : 1;
        });
        expect(cursors).toEqual(ordered);
        expect(new Set(cursors).size).toBe(cursors.length);
        expect((await botPost(1, conv, { type: 'typing' })).status).toBe(200);
        await live.waitFor(frames => frames.some(frame => frame.activities.some(a => a.type === 'typing')));
        expect(live.frames.at(-1)!.watermark).toBeUndefined();
        await close(live.ws);
        const resumed = await stream(1, conv, token, cursors.at(-1));
        await delay(100);
        expect(resumed.activities()).toEqual([]);
        const replay = await stream(1, conv, token);
        await replay.waitFor(frames => frames.flatMap(frame => frame.activities).length >= 12);
        expect(
            replay
                .activities()
                .map(a => a.id)
                .sort()
        ).toEqual([...ids].sort());
    }, 10000);

    it('rejects a valid token belonging to another conversation over HTTP and WebSocket', async () => {
        const conv = `${prefix}-auth`;
        const token = tokenFor(`${prefix}-other`);
        expect((await request(1, `/v3/directline/conversations/${conv}`, token)).status).toBe(401);
        expect(
            (await request(0, `/v3/directline/conversations/${conv}/activities`, token, { type: 'message' })).status
        ).toBe(401);
        const gateway = apps[1].get(DirectLineGateway);
        const wss = (gateway as unknown as { wss: WebSocketServer }).wss;
        const ws = new WebSocket(
            `ws://127.0.0.1:${(wss.address() as AddressInfo).port}/v3/directline/conversations/${conv}/stream?t=${token}`
        );
        sockets.push(ws);
        const code = await new Promise<number>((resolve, reject) => {
            ws.once('close', resolve);
            ws.once('error', reject);
        });
        expect(code).toBe(1008);
    });

    it('replays retained legacy records at cutover and then resumes with a delivery cursor', async () => {
        const conv = `${prefix}-legacy-cutover`;
        const token = tokenFor(conv);
        const key = `obf:conv:${conv}:activities`;
        for (const seq of [0, 1]) {
            await clients[0].zadd(
                key,
                Date.now(),
                JSON.stringify({ seq, activity: { id: `${conv}|${seq}`, type: 'message' } })
            );
        }
        await clients[0].expire(key, 300);
        await clients[0].set(conv, '2', 'EX', 300);
        const response = await botPost(1, conv, { type: 'message', text: 'after-cutover' });
        expect(response.status).toBe(200);
        const posted = (await response.json()) as { id: string };
        const replay = await stream(0, conv, token, '0');
        await replay.waitFor(frames => frames.flatMap(frame => frame.activities).length >= 2);
        expect(replay.activities().map(a => a.id)).toEqual([`${conv}|1`, posted.id]);
        const watermark = replay.frames.at(-1)!.watermark!;
        expect(watermark).toMatch(/^v2:\d+-\d+$/);
        await close(replay.ws);
        const resumed = await stream(1, conv, token, watermark);
        await delay(100);
        expect(resumed.activities()).toEqual([]);
    });

    it('replays a new publication after the activity ID counter expires', async () => {
        const conv = `${prefix}-counter-expiry`;
        const token = tokenFor(conv);
        const firstResponse = await botPost(0, conv, { type: 'message', text: 'before-expiry' });
        expect(firstResponse.status).toBe(200);
        const firstId = ((await firstResponse.json()) as { id: string }).id;
        const first = await stream(0, conv, token);
        await first.waitFor(frames => frames.flatMap(frame => frame.activities).length === 1);
        const watermark = first.frames.at(-1)!.watermark!;
        await close(first.ws);
        // Emulate expiry of this run's ID counter only. UI ID collisions remain an existing limitation.
        await clients[0].del(conv);
        const secondResponse = await botPost(1, conv, { type: 'message', text: 'after-expiry' });
        expect(secondResponse.status).toBe(200);
        expect(((await secondResponse.json()) as { id: string }).id).toBe(firstId);
        const resumed = await stream(1, conv, token, watermark);
        await resumed.waitFor(frames => frames.flatMap(frame => frame.activities).length >= 1);
        await delay(100);
        expect(resumed.activities().map(a => a.text)).toEqual(['after-expiry']);
        expect(resumed.frames.at(-1)!.watermark).not.toBe(watermark);
    });

    it('closes sockets on subscriber loss and replays publications missed during the interruption', async () => {
        const conv = `${prefix}-subscriber-loss`;
        const token = tokenFor(conv);
        expect((await botPost(1, conv, { type: 'message', text: 'before-loss' })).status).toBe(200);
        const first = await stream(0, conv, token);
        await first.waitFor(frames => frames.flatMap(frame => frame.activities).length === 1);
        const watermark = first.frames.at(-1)!.watermark!;
        const closed = new Promise<number>(resolve => first.ws.once('close', resolve));
        clients[1].disconnect();
        try {
            expect(await closed).toBe(1011);
            expect((await botPost(1, conv, { type: 'message', text: 'during-loss' })).status).toBe(200);
            const resumed = await stream(1, conv, token, watermark);
            await resumed.waitFor(frames => frames.flatMap(frame => frame.activities).length >= 1);
            await delay(100);
            expect(resumed.activities().map(a => a.text)).toEqual(['during-loss']);
        } finally {
            await clients[1].connect();
        }
    });

    it('stores and delivers once when Redis resends an already committed publication command', async () => {
        const conv = `${prefix}-redis-resend`;
        const token = tokenFor(conv);
        const live = await stream(0, conv, token);
        const redis = clients[2];
        const original = redis.eval.bind(redis) as (...args: Parameters<Redis['eval']>) => Promise<unknown>;
        const resend = jest.spyOn(redis, 'eval').mockImplementationOnce(async (...args) => {
            // Emulate a lost acknowledgement: Redis commits, then ioredis resends identical EVAL arguments.
            await original(...args);
            return original(...args);
        });
        try {
            const response = await botPost(1, conv, { type: 'message', text: 'one-logical-publication' });
            expect(response.status).toBe(200);
            const posted = (await response.json()) as { id: string };
            expect(resend).toHaveBeenCalledTimes(1);
            await live.waitFor(frames => frames.flatMap(frame => frame.activities).length >= 1);
            await delay(100);
            expect(live.activities().map(a => a.id)).toEqual([posted.id]);
            const replay = await stream(1, conv, token);
            await replay.waitFor(frames => frames.flatMap(frame => frame.activities).length >= 1);
            await delay(100);
            expect(replay.activities().map(a => a.id)).toEqual([posted.id]);
        } finally {
            resend.mockRestore();
        }
    });

    // Optional compatibility test uses an existing webchat installation, never downloads dependencies.
    (process.env.OBF_TEST_DIRECTLINE_MODULE_DIR ? it : it.skip)(
        'round-trips opaque watermarks through the real DirectLine JavaScript client',
        async () => {
            type Client = {
                watermark: string;
                activity$: { subscribe: (next: (activity: Activity) => void) => { unsubscribe: () => void } };
                end: () => void;
            };
            type Observer = { next: (value: unknown) => void; complete: () => void; error: (error: unknown) => void };
            type AjaxOptions = { url: string; method?: string; headers?: Record<string, string>; body?: unknown };
            const requireClient = createRequire(`${process.env.OBF_TEST_DIRECTLINE_MODULE_DIR}/package.json`);
            const { DirectLine } = requireClient('./lib/directLine') as {
                DirectLine: new (options: Record<string, unknown>) => Client;
            };
            const { Observable } = requireClient('rxjs/Observable') as {
                Observable: { create: (callback: (observer: Observer) => void) => unknown };
            };
            const requests: string[] = [];
            const ajax = (options: AjaxOptions) =>
                Observable.create(observer => {
                    requests.push(options.url);
                    void fetch(options.url, {
                        method: options.method || 'GET',
                        headers: options.headers,
                        ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) })
                    })
                        .then(async response => {
                            if (!response.ok) {
                                throw Object.assign(new Error(`HTTP ${response.status}`), { status: response.status });
                            }
                            observer.next({ response: (await response.json()) as unknown, status: response.status });
                            observer.complete();
                        })
                        .catch((error: unknown) => observer.error(error));
                });
            const conv = `${prefix}-directlinejs`;
            const token = tokenFor(conv);
            const running: Array<() => void> = [];
            const start = (replica: number, watermark?: string) => {
                const client = new DirectLine({
                    token,
                    conversationId: conv,
                    watermark,
                    domain: `${urls[replica]}/v3/directline`,
                    webSocket: true,
                    timeout: 2000,
                    ajax,
                    WebSocket
                });
                const received: Activity[] = [];
                const subscription = client.activity$.subscribe(activity => received.push(activity));
                const stop = () => {
                    subscription.unsubscribe();
                    client.end();
                };
                running.push(stop);
                return { client, received, stop };
            };
            const waitFor = async (predicate: () => boolean) => {
                const deadline = Date.now() + 3000;
                while (!predicate() && Date.now() < deadline) {
                    await delay(10);
                }
                expect(predicate()).toBe(true);
            };
            try {
                expect((await botPost(1, conv, { type: 'message', text: 'before-client' })).status).toBe(200);
                const first = start(0);
                await waitFor(() => first.received.length === 1);
                const watermark = first.client.watermark;
                expect(watermark).toMatch(/^v2:\d+-\d+$/);
                first.stop();
                expect((await botPost(0, conv, { type: 'message', text: 'while-offline' })).status).toBe(200);
                const second = start(1, watermark);
                await waitFor(() => second.received.length >= 1);
                await delay(100);
                expect(second.received.map(a => a.text)).toEqual(['while-offline']);
                expect(requests.some(url => new URL(url).searchParams.get('watermark') === watermark)).toBe(true);
                expect(second.client.watermark).not.toBe(watermark);
            } finally {
                running.forEach(stop => stop());
            }
        },
        10000
    );
});
