/** ioredis client for commands: counters, activity store, publish, rate limit. */
export const REDIS_CLIENT = 'REDIS_CLIENT';

/** ioredis client in subscriber mode. A subscribed connection cannot run normal commands. */
export const REDIS_SUBSCRIBER = 'REDIS_SUBSCRIBER';
