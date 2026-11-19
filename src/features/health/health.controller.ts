import { Controller, Get, Inject, Res } from '@nestjs/common';
import { FastifyReply } from 'fastify';
import Redis from 'ioredis';
import { DataSource } from 'typeorm';
import { REDIS_CLIENT, REDIS_SUBSCRIBER } from '../redis/redis.constants';
import { DrainStateService } from './drain-state.service';

const CHECK_TIMEOUT_MS = 1000;

type CheckResult = 'ok' | 'down';

interface ReadinessResponse {
    status: 'ok' | 'fail' | 'draining';
    checks?: { redis: CheckResult; subscriber: CheckResult; db: CheckResult };
}

/** Resolves 'ok' if the check finishes in time, 'down' if it throws or times out. */
async function probe(check: () => Promise<unknown>): Promise<CheckResult> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('timeout')), CHECK_TIMEOUT_MS);
    });
    try {
        await Promise.race([check(), timeout]);
        return 'ok';
    } catch {
        return 'down';
    } finally {
        clearTimeout(timer);
    }
}

@Controller('health')
export class HealthController {
    constructor(
        @Inject(REDIS_CLIENT) private readonly redis: Redis,
        @Inject(REDIS_SUBSCRIBER) private readonly subscriber: Redis,
        private readonly dataSource: DataSource,
        private readonly drainState: DrainStateService
    ) {}

    /**
     * GET /health
     * Liveness probe. Returns 200 while the process serves HTTP. Does not check DB, Redis, or the WebSocket server.
     */
    @Get()
    check(): { status: string } {
        return { status: 'ok' };
    }

    /**
     * GET /health/ready
     * Readiness probe. 200 when Redis (commands and subscriber) and the DB answer, 503 otherwise or
     * while the pod drains for shutdown. Deliberately has no load-based checks.
     */
    @Get('ready')
    async ready(@Res({ passthrough: true }) reply: FastifyReply): Promise<ReadinessResponse> {
        if (this.drainState.isDraining()) {
            reply.status(503);
            return { status: 'draining' };
        }
        const [redis, db] = await Promise.all([
            probe(() => this.redis.ping()),
            probe(() => this.dataSource.query('SELECT 1'))
        ]);
        const subscriber: CheckResult = this.subscriber.status === 'ready' ? 'ok' : 'down';
        const checks = { redis, subscriber, db };
        const healthy = Object.values(checks).every(result => result === 'ok');
        reply.status(healthy ? 200 : 503);
        return { status: healthy ? 'ok' : 'fail', checks };
    }
}
