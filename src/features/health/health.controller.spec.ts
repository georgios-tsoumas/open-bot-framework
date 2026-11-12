import { FastifyReply } from 'fastify';
import Redis from 'ioredis';
import { DataSource } from 'typeorm';
import { DrainStateService } from './drain-state.service';
import { HealthController } from './health.controller';

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
            drainState
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
