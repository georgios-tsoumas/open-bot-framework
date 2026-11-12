import { Global, Inject, Logger, Module, OnApplicationShutdown, Provider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import { REDIS_CLIENT, REDIS_SUBSCRIBER } from './redis.constants';

const logger = new Logger('RedisModule');

/**
 * Open a Redis connection or fail startup. Redis is required: every replica shares the activity
 * counter, the activity store and the pub/sub channels through it.
 */
async function connect(configService: ConfigService, name: string): Promise<Redis> {
    const uri = configService.get<string>('REDIS_URI');
    if (!uri) {
        throw new Error('REDIS_URI is required');
    }
    const client = new Redis(uri, { lazyConnect: true, connectTimeout: 2000 });
    client.on('error', (err: Error) => logger.error(`${name}: ${err.message}`));
    try {
        await client.connect();
    } catch (e: unknown) {
        client.disconnect();
        throw new Error(`${name}: cannot connect to Redis. ${String(e)}`);
    }
    return client;
}

const clientProvider = (token: string): Provider => ({
    provide: token,
    inject: [ConfigService],
    useFactory: (configService: ConfigService) => connect(configService, token)
});

@Global()
@Module({
    providers: [clientProvider(REDIS_CLIENT), clientProvider(REDIS_SUBSCRIBER)],
    exports: [REDIS_CLIENT, REDIS_SUBSCRIBER]
})
export class RedisModule implements OnApplicationShutdown {
    constructor(
        @Inject(REDIS_CLIENT) private readonly client: Redis,
        @Inject(REDIS_SUBSCRIBER) private readonly subscriber: Redis
    ) {}

    /** Runs after the gateway has drained, so no socket still needs Redis. */
    async onApplicationShutdown() {
        await Promise.allSettled([this.client.quit(), this.subscriber.quit()]);
    }
}
