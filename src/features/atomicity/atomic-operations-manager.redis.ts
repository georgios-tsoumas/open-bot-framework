import { Redis } from 'ioredis';
import { AtomicOperationsManager } from './atomicity-operations-manager.interface';

/**
 * How long a conversation's counter lives after its last activity. When it expires, ids restart at
 * `|0000000` and webchat overwrites the earlier activity with the same id, so it must outlive any
 * realistic idle period.
 */
export const COUNTER_TTL_SECONDS = 86_400;

export class RedisAtomicOperationsManager implements AtomicOperationsManager {
    constructor(private readonly client: Redis) {}

    /**
     * Increment the counter and refresh its TTL in one MULTI, so a crash cannot leave a counter
     * without an expiry. Returns the new value minus 1, so the first activity gets 0.
     * @param key - The Redis key to increment.
     * @returns The sequence number taken by this call.
     * @throws If Redis reports an error or the INCR result is not a finite number.
     */
    async incr(key: string): Promise<number> {
        const results = await this.client.multi().incr(key).expire(key, COUNTER_TTL_SECONDS).exec();
        const [err, value] = results?.[0] ?? [new Error('Empty MULTI result'), null];
        if (err) {
            throw err;
        }
        const seq = Number(value) - 1;
        if (!Number.isFinite(seq)) {
            throw new Error(`Unexpected INCR result: ${String(value)}`);
        }
        return seq;
    }
}
