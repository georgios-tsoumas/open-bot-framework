import { Provider } from '@nestjs/common';
import Redis from 'ioredis';
import { REDIS_CLIENT } from '../redis/redis.constants';
import { AtomicOperationsManager } from './atomicity-operations-manager.interface';
import { RedisAtomicOperationsManager } from './atomic-operations-manager.redis';

/** Redis only. An in-memory counter hands out the same ids on every replica. */
export const AtomicOperationsProvider: Provider = {
    provide: 'ATOMIC_OPERATIONS_PROVIDER',
    inject: [REDIS_CLIENT],
    useFactory: (client: Redis): AtomicOperationsManager => new RedisAtomicOperationsManager(client)
};
