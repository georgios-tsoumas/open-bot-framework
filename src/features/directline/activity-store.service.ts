import { Inject, Injectable } from '@nestjs/common';
import { Activity } from 'botframework-schema';
import Redis from 'ioredis';
import { REDIS_CLIENT } from '../redis/redis.constants';
import { activityStoreKey, StoredActivity } from './conversation-stream.types';

/** How long an activity stays available for replay after it was created. */
export const ACTIVITY_RETENTION_MS = 300_000;

/**
 * Short-lived per-conversation activity log in Redis, shared by all replicas. It covers the gap while
 * a client reconnects (deploy, pod restart, network drop): the client resumes with its last watermark
 * and gets every activity after it.
 *
 * Sorted set, score = creation time in ms, member = JSON StoredActivity (unique: it holds the id).
 */
@Injectable()
export class ActivityStoreService {
    constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {}

    /** Save an activity and drop entries older than the retention window. */
    async save(conversationId: string, seq: number, activity: Activity): Promise<void> {
        const key = activityStoreKey(conversationId);
        const now = Date.now();
        const member: StoredActivity = { seq, activity };
        const results = await this.redis
            .multi()
            .zadd(key, now, JSON.stringify(member))
            .zremrangebyscore(key, '-inf', now - ACTIVITY_RETENTION_MS)
            .expire(key, ACTIVITY_RETENTION_MS / 1000)
            .exec();
        if (!results) {
            throw new Error('Empty MULTI result');
        }
        const error = results.find(([err]) => err)?.[0];
        if (error) {
            throw error;
        }
    }

    /**
     * Activities newer than the retention window with seq > afterSeq, oldest first.
     * @param afterSeq - the client's watermark, or -1 when it has none (returns everything stored).
     */
    async after(conversationId: string, afterSeq: number): Promise<StoredActivity[]> {
        const raw = await this.redis.zrangebyscore(
            activityStoreKey(conversationId),
            Date.now() - ACTIVITY_RETENTION_MS,
            '+inf'
        );
        return raw
            .map(entry => JSON.parse(entry) as StoredActivity)
            .filter(stored => stored.seq > afterSeq)
            .sort((a, b) => a.seq - b.seq);
    }
}
