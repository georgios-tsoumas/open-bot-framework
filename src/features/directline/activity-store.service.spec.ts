import { Activity } from 'botframework-schema';
import Redis from 'ioredis';
import { ACTIVITY_RETENTION_MS, ActivityStoreService } from './activity-store.service';

describe('ActivityStoreService', () => {
    const now = 1_700_000_000_000;
    let multi: { zadd: jest.Mock; zremrangebyscore: jest.Mock; expire: jest.Mock; exec: jest.Mock };
    let redis: { multi: jest.Mock; zrangebyscore: jest.Mock };
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
        redis = { multi: jest.fn(() => multi), zrangebyscore: jest.fn().mockResolvedValue([]) };
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

    it('returns everything stored for afterSeq -1, including seq 0', async () => {
        redis.zrangebyscore.mockResolvedValueOnce(
            [0, 1].map(seq => JSON.stringify({ seq, activity: { id: `conv1|${seq}` } }))
        );
        expect((await store.after('conv1', -1)).map(s => s.seq)).toEqual([0, 1]);
    });
});
