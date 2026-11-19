import { Inject, Injectable } from '@nestjs/common';
import { Activity } from 'botframework-schema';
import { randomUUID } from 'crypto';
import Redis from 'ioredis';
import { REDIS_CLIENT } from '../redis/redis.constants';
import {
    activityStoreKey,
    activityStreamKey,
    compareDeliveryCursors,
    conversationChannel,
    isDeliveryCursor,
    StoredActivity
} from './conversation-stream.types';

/** How long an activity stays available for replay after it was created. */
export const ACTIVITY_RETENTION_MS = 300_000;

/**
 * Short-lived per-conversation activity log in Redis, shared by all replicas. It covers the gap while
 * a client reconnects (deploy, pod restart, network drop): the client resumes with its last watermark
 * and gets every activity after it.
 *
 * New publications use a Redis stream and atomic publish. The old sorted set remains readable for
 * clients reconnecting with a numeric watermark during a coordinated version cutover.
 */
@Injectable()
export class ActivityStoreService {
    constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {}

    /** Allocate the delivery cursor, store and publish without another replica interleaving. */
    async saveAndPublish(conversationId: string, seq: number, activity: Activity): Promise<void> {
        await this.redis.eval(
            `local existing = redis.call('GET', KEYS[2])
             if existing then return existing end
             local id = redis.call('XADD', KEYS[1], '*', 'seq', ARGV[1], 'activity', ARGV[2])
             local milliseconds = tonumber(string.match(id, '^(%d+)-'))
             local cutoff = string.format('%.0f', math.max(0, milliseconds - tonumber(ARGV[3]))) .. '-0'
             redis.call('XTRIM', KEYS[1], 'MINID', cutoff)
             redis.call('PEXPIRE', KEYS[1], ARGV[3])
             local message = '{"seq":' .. ARGV[1] .. ',"cursor":"v2:' .. id .. '","activity":' .. ARGV[2] .. '}'
             redis.call('PUBLISH', ARGV[4], message)
             redis.call('SET', KEYS[2], id, 'PX', ARGV[3])
             return id`,
            2,
            activityStreamKey(conversationId),
            // ioredis resends the same command arguments when its acknowledgement was lost.
            `${activityStreamKey(conversationId)}:publication:${randomUUID()}`,
            String(seq),
            JSON.stringify(activity),
            ACTIVITY_RETENTION_MS,
            conversationChannel(conversationId)
        );
    }

    /** Save in the legacy ID-based log (retained for migration fixtures and older stored history). */
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
     * Activities newer than the retention window, in publication order for versioned cursors.
     * @param afterSeq - delivery cursor, legacy sequence, or -1 to replay retained history.
     */
    async after(conversationId: string, afterSeq: number | string): Promise<StoredActivity[]> {
        const cursor = typeof afterSeq === 'string' && isDeliveryCursor(afterSeq) ? afterSeq : undefined;
        const [seconds, microseconds] = await this.redis.time();
        const cutoff = Math.max(
            0,
            Number(seconds) * 1000 + Math.floor(Number(microseconds) / 1000) - ACTIVITY_RETENTION_MS
        );
        const minimum = `v2:${cutoff}-0`;
        const lower = cursor && compareDeliveryCursors(cursor, minimum) >= 0 ? `(${cursor.slice(3)}` : minimum.slice(3);
        const entries = await this.redis.xrange(activityStreamKey(conversationId), lower, '+');
        const stream = entries.map(([id, fields]) => ({
            seq: Number(fields[1]),
            activity: JSON.parse(fields[3]) as Activity,
            cursor: `v2:${id}`
        }));
        if (cursor) {
            return stream;
        }
        // Numeric watermarks belong to the old ID-based log. Replay retained new-protocol entries
        // as well; a numeric ID cannot identify a position in their publication order.
        const raw = await this.redis.zrangebyscore(
            activityStoreKey(conversationId),
            Date.now() - ACTIVITY_RETENTION_MS,
            '+inf'
        );
        const legacy = raw
            .map(entry => JSON.parse(entry) as StoredActivity)
            .filter(stored => stored.seq > Number(afterSeq))
            .sort((a, b) => a.seq - b.seq);
        return [...legacy, ...stream];
    }
}
