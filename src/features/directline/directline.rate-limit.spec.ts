import { HttpException, HttpStatus } from '@nestjs/common';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import rateLimit from '@fastify/rate-limit';
import { AllExceptionsFilter } from 'src/filters/exception.filter';
import { DirectlineConversationService } from './directline-conversation.service';
import { DirectlineTokenService } from './dirtectline-token.service';
import { DirectlineController } from './directline.controller';

describe('DirectLine rate limits', () => {
    let app: NestFastifyApplication;

    beforeAll(async () => {
        process.env.RATE_LIMIT_TOKENS_PER_MINUTE = '2';
        process.env.RATE_LIMIT_MESSAGES_PER_MINUTE = '2';
        const moduleRef = await Test.createTestingModule({
            controllers: [DirectlineController],
            providers: [
                { provide: DirectlineTokenService, useValue: { generateToken: () => ({ token: 't' }) } },
                { provide: DirectlineConversationService, useValue: { userReplyToConversation: () => ({ id: '1' }) } }
            ]
        }).compile();
        // Same setup as main.ts
        app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter({ trustProxy: 1 }));
        await app.register(rateLimit, {
            global: false,
            errorResponseBuilder: () => new HttpException('Too many requests', HttpStatus.TOO_MANY_REQUESTS)
        });
        app.useGlobalFilters(new AllExceptionsFilter());
        await app.init();
        await app.getHttpAdapter().getInstance().ready();
    });

    afterAll(async () => {
        await app.close();
        delete process.env.RATE_LIMIT_TOKENS_PER_MINUTE;
        delete process.env.RATE_LIMIT_MESSAGES_PER_MINUTE;
    });

    const send = (convId: string) =>
        app.inject({ method: 'POST', url: `/v3/directline/conversations/${convId}/activities`, payload: {} });
    const token = (ip?: string) =>
        app.inject({
            method: 'POST',
            url: '/v3/directline/tokens/generate',
            headers: ip ? { 'x-forwarded-for': ip } : {}
        });

    it('limits messages per conversation with 429', async () => {
        expect((await send('conv1')).statusCode).toBe(200);
        expect((await send('conv1')).statusCode).toBe(200);
        expect((await send('conv1')).statusCode).toBe(429);
        expect((await send('conv2')).statusCode).toBe(200);
    });

    it('limits tokens per client IP from X-Forwarded-For', async () => {
        expect((await token('10.0.0.1')).statusCode).toBe(200);
        expect((await token('10.0.0.1')).statusCode).toBe(200);
        expect((await token('10.0.0.1')).statusCode).toBe(429);
        expect((await token('10.0.0.2')).statusCode).toBe(200);
    });

    it('falls back to the connection IP when X-Forwarded-For is missing', async () => {
        expect((await token()).statusCode).toBe(200);
        expect((await token()).statusCode).toBe(200);
        expect((await token()).statusCode).toBe(429);
    });
});
