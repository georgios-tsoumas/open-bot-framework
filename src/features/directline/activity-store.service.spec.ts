import { Activity } from 'botframework-schema';
import Redis from 'ioredis';
import { ACTIVITY_RETENTION_MS, ActivityStoreService } from './activity-store.service';

describe('ActivityStoreService', () => {
    const now = 1_700_000_000_000;
    let multi: { zadd: jest.Mock; zremrangebyscore: jest.Mock; expire: jest.Mock; exec: jest.Mock };
    let redis: { multi: jest.Mock; zrangebyscore: jest.Mock; xrange: jest.Mock; time: jest.Mock };
    let store: ActivityStoreService;

    beforeEach(() => {
        jest.spyOn(Date, 'now').mockReturnValue(now);
        multi = {
            zadd: jest.fn(() => multi),
            zremrangebyscore: jest.fn(() => multi),
            expire: jest.fn(() => multi),
            exec: jest.fn().mockResolvedValue([
                [null, 1],
                [null, 0],
                [null, 1]
            ])
        };
        redis = {
            multi: jest.fn(() => multi),
            zrangebyscore: jest.fn().mockResolvedValue([]),
            xrange: jest.fn().mockResolvedValue([]),
            time: jest.fn().mockResolvedValue([String(now / 1000), '0'])
        };
        store = new ActivityStoreService(redis as unknown as Redis);
    });

    afterEach(() => jest.restoreAllMocks());

    it('saves the activity scored by time, trims old entries and refreshes the key TTL', async () => {
        const activity = { id: 'conv1|0000003', type: 'message' } as Activity;
        await store.save('conv1', 3, activity);
        const key = 'obf:conv:conv1:activities';
        expect(multi.zadd).toHaveBeenCalledWith(key, now, JSON.stringify({ seq: 3, activity }));
        expect(multi.zremrangebyscore).toHaveBeenCalledWith(key, '-inf', now - ACTIVITY_RETENTION_MS);
        expect(multi.expire).toHaveBeenCalledWith(key, 300);
    });

    it('throws when a command in the MULTI failed', async () => {
        multi.exec.mockResolvedValueOnce([
            [new Error('OOM'), null],
            [null, 0],
            [null, 1]
        ]);
        await expect(store.save('conv1', 1, {} as Activity)).rejects.toThrow('OOM');
    });

    it('throws when the MULTI was aborted', async () => {
        multi.exec.mockResolvedValueOnce(null);
        await expect(store.save('conv1', 1, {} as Activity)).rejects.toThrow('Empty MULTI result');
    });

    it('returns activities after the watermark from the retention window, ordered by seq', async () => {
        redis.zrangebyscore.mockResolvedValueOnce(
            [7, 5, 6, 4].map(seq => JSON.stringify({ seq, activity: { id: `conv1|${seq}` } }))
        );
        const result = await store.after('conv1', 4);
        expect(redis.zrangebyscore).toHaveBeenCalledWith(
            'obf:conv:conv1:activities',
            now - ACTIVITY_RETENTION_MS,
            '+inf'
        );
        expect(result.map(s => s.seq)).toEqual([5, 6, 7]);
    });

    describe('delivery cursor replay', () => {
        it('returns publication order even when activity IDs go backwards', async () => {
            redis.xrange.mockResolvedValueOnce([
                [`${now}-0`, ['seq', '9', 'activity', JSON.stringify({ id: 'conv1|9' })]],
                [`${now}-1`, ['seq', '1', 'activity', JSON.stringify({ id: 'conv1|1' })]]
            ]);
            const result = await store.after('conv1', `v2:${now - 1}-0`);
            expect(redis.xrange).toHaveBeenCalledWith('obf:conv:conv1:stream', `(${now - 1}-0`, '+');
            expect(result.map(s => s.seq)).toEqual([9, 1]);
            expect(result.map(s => s.cursor)).toEqual([`v2:${now}-0`, `v2:${now}-1`]);
            expect(redis.zrangebyscore).not.toHaveBeenCalled();
        });

        it('bounds replay by Redis time rather than an application clock', async () => {
            await store.after('conv1', 'v2:1-0');
            expect(redis.xrange).toHaveBeenCalledWith('obf:conv:conv1:stream', `${now - ACTIVITY_RETENTION_MS}-0`, '+');
        });

        it('includes new publications when resuming a legacy numeric watermark', async () => {
            redis.zrangebyscore.mockResolvedValueOnce([JSON.stringify({ seq: 8, activity: { id: 'conv1|8' } })]);
            redis.xrange.mockResolvedValueOnce([
                [`${now}-0`, ['seq', '2', 'activity', JSON.stringify({ id: 'conv1|2' })]]
            ]);
            const result = await store.after('conv1', 7);
            expect(result.map(s => s.seq)).toEqual([8, 2]);
            expect(result[1].cursor).toBe(`v2:${now}-0`);
        });
    });

    it('returns everything stored for afterSeq -1, including seq 0', async () => {
        redis.zrangebyscore.mockResolvedValueOnce(
            [0, 1].map(seq => JSON.stringify({ seq, activity: { id: `conv1|${seq}` } }))
        );
        expect((await store.after('conv1', -1)).map(s => s.seq)).toEqual([0, 1]);
    });
});
