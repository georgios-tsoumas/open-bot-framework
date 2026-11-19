import Redis from 'ioredis';
import { COUNTER_TTL_SECONDS, RedisAtomicOperationsManager } from './atomic-operations-manager.redis';

describe('RedisAtomicOperationsManager', () => {
    let multi: { incr: jest.Mock; expire: jest.Mock; exec: jest.Mock };
    let manager: RedisAtomicOperationsManager;

    beforeEach(() => {
        multi = { incr: jest.fn(() => multi), expire: jest.fn(() => multi), exec: jest.fn() };
        manager = new RedisAtomicOperationsManager({ multi: () => multi } as unknown as Redis);
    });

    it('increments and refreshes a 24h TTL in one MULTI, first seq is 0', async () => {
        multi.exec.mockResolvedValueOnce([
            [null, 1],
            [null, 1]
        ]);
        await expect(manager.incr('conv1')).resolves.toBe(0);
        expect(multi.incr).toHaveBeenCalledWith('conv1');
        expect(multi.expire).toHaveBeenCalledWith('conv1', COUNTER_TTL_SECONDS);
        expect(COUNTER_TTL_SECONDS).toBe(86_400);
    });

    it('throws the INCR error', async () => {
        multi.exec.mockResolvedValueOnce([
            [new Error('WRONGTYPE'), null],
            [null, 1]
        ]);
        await expect(manager.incr('conv1')).rejects.toThrow('WRONGTYPE');
    });

    it('throws when the MULTI was aborted', async () => {
        multi.exec.mockResolvedValueOnce(null);
        await expect(manager.incr('conv1')).rejects.toThrow('Empty MULTI result');
    });
});
