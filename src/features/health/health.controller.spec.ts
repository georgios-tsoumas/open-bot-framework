import { ConfigService } from '@nestjs/config';
import { FastifyReply } from 'fastify';
import Redis from 'ioredis';
import { DataSource } from 'typeorm';
import { DrainStateService } from './drain-state.service';
import { HealthController } from './health.controller';
import { SocketLoadService } from './socket-load.service';

describe('HealthController', () => {
    let redis: { ping: jest.Mock };
    let subscriber: { status: string };
    let dataSource: { query: jest.Mock };
    let drainState: DrainStateService;
    let controller: HealthController;
    let reply: { status: jest.Mock };

    beforeEach(() => {
        redis = { ping: jest.fn().mockResolvedValue('PONG') };
        subscriber = { status: 'ready' };
        dataSource = { query: jest.fn().mockResolvedValue([{ 1: 1 }]) };
        drainState = new DrainStateService();
        controller = new HealthController(
            redis as unknown as Redis,
            subscriber as unknown as Redis,
            dataSource as unknown as DataSource,
            drainState,
            new SocketLoadService({ get: () => undefined } as unknown as ConfigService)
        );
        reply = { status: jest.fn() };
    });

    const ready = () => controller.ready(reply as unknown as FastifyReply);

    it('liveness returns ok', () => {
        expect(controller.check()).toEqual({ status: 'ok' });
    });

    it('readiness is 200 when Redis, the subscriber and the DB answer', async () => {
        await expect(ready()).resolves.toEqual({
            status: 'ok',
            checks: { redis: 'ok', subscriber: 'ok', db: 'ok' }
        });
        expect(reply.status).toHaveBeenCalledWith(200);
        expect(dataSource.query).toHaveBeenCalledWith('SELECT 1');
    });

    it('readiness is 503 when Redis fails', async () => {
        redis.ping.mockRejectedValueOnce(new Error('ECONNREFUSED'));
        await expect(ready()).resolves.toMatchObject({ status: 'fail', checks: { redis: 'down' } });
        expect(reply.status).toHaveBeenCalledWith(503);
    });

    it('readiness is 503 when the subscriber connection is not ready', async () => {
        subscriber.status = 'reconnecting';
        await expect(ready()).resolves.toMatchObject({ status: 'fail', checks: { subscriber: 'down' } });
        expect(reply.status).toHaveBeenCalledWith(503);
    });

    it('readiness is 503 when the DB does not answer within 1s', async () => {
        jest.useFakeTimers();
        try {
            dataSource.query.mockReturnValueOnce(new Promise(() => undefined));
            const result = ready();
            await jest.advanceTimersByTimeAsync(1000);
            await expect(result).resolves.toMatchObject({ status: 'fail', checks: { db: 'down' } });
        } finally {
            jest.useRealTimers();
        }
    });

    it('readiness is 503 draining during shutdown, without running checks', async () => {
        drainState.start();
        await expect(ready()).resolves.toEqual({ status: 'draining' });
        expect(reply.status).toHaveBeenCalledWith(503);
        expect(redis.ping).not.toHaveBeenCalled();
    });
});

describe('HealthController GET /health/load', () => {
    let redis: { ping: jest.Mock };
    let subscriber: { status: string };
    let drainState: DrainStateService;
    let reply: { status: jest.Mock };

    const loadWith = (maxSockets: string | undefined, sockets: number) => {
        const socketLoad = new SocketLoadService({
            get: (key: string) => (key === 'MAX_WS_CONNECTIONS' ? maxSockets : undefined)
        } as unknown as ConfigService);
        socketLoad.update(sockets);
        const controller = new HealthController(
            redis as unknown as Redis,
            subscriber as unknown as Redis,
            { query: jest.fn().mockResolvedValue([{ 1: 1 }]) } as unknown as DataSource,
            drainState,
            socketLoad
        );
        return { socketLoad, load: () => controller.load(reply as unknown as FastifyReply) };
    };

    beforeEach(() => {
        redis = { ping: jest.fn().mockResolvedValue('PONG') };
        subscriber = { status: 'ready' };
        drainState = new DrainStateService();
        reply = { status: jest.fn() };
    });

    it('is 200 with the socket count when healthy and under the cap', async () => {
        await expect(loadWith('3', 2).load()).resolves.toEqual({
            status: 'ok',
            checks: { redis: 'ok', subscriber: 'ok', db: 'ok' },
            sockets: 2,
            maxSockets: 3
        });
        expect(reply.status).toHaveBeenCalledWith(200);
    });

    it('is 503 full at the cap, and 200 again once sockets drop below it', async () => {
        const { socketLoad, load } = loadWith('3', 3);
        await expect(load()).resolves.toMatchObject({ status: 'full', sockets: 3, maxSockets: 3 });
        expect(reply.status).toHaveBeenLastCalledWith(503);
        socketLoad.update(2);
        await expect(load()).resolves.toMatchObject({ status: 'ok', sockets: 2 });
        expect(reply.status).toHaveBeenLastCalledWith(200);
    });

    it('is never full without a cap', async () => {
        await expect(loadWith(undefined, 100000).load()).resolves.toMatchObject({
            status: 'ok',
            sockets: 100000,
            maxSockets: null
        });
        expect(reply.status).toHaveBeenCalledWith(200);
    });

    it('is 503 fail when a readiness check fails, even under the cap', async () => {
        redis.ping.mockRejectedValueOnce(new Error('ECONNREFUSED'));
        await expect(loadWith('3', 0).load()).resolves.toMatchObject({
            status: 'fail',
            checks: { redis: 'down' },
            sockets: 0,
            maxSockets: 3
        });
        expect(reply.status).toHaveBeenCalledWith(503);
    });

    it('is 503 draining during shutdown, without running checks', async () => {
        drainState.start();
        await expect(loadWith('3', 0).load()).resolves.toEqual({ status: 'draining' });
        expect(reply.status).toHaveBeenCalledWith(503);
        expect(redis.ping).not.toHaveBeenCalled();
    });

    it('fails startup when MAX_WS_CONNECTIONS is not a positive integer', () => {
        expect(() => loadWith('0', 0)).toThrow('MAX_WS_CONNECTIONS must be a positive integer');
        expect(() => loadWith('ten', 0)).toThrow('MAX_WS_CONNECTIONS must be a positive integer');
    });
});
