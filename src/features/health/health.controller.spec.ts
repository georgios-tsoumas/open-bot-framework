import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { DirectLineGateway, DirectLineGatewayStats } from '../directline/directline.gateway';
import { HealthController } from './health.controller';

describe('HealthController', () => {
    let app: NestFastifyApplication;
    const stats: DirectLineGatewayStats = {
        listening: true,
        clients: 2,
        conversations: 2,
        pendingDeliveries: 1,
        counters: {
            connectionsAccepted: 3,
            connectionsRejected: 0,
            connectionsReplaced: 1,
            connectionsClosed: 1,
            socketErrors: 0,
            heartbeatTimeouts: 0,
            deliveriesSent: 5,
            deliveriesNoOpenSocket: 0,
            deliveriesFailed: 0,
            deliveriesWaited: 2
        }
    };

    beforeAll(async () => {
        const moduleRef = await Test.createTestingModule({
            controllers: [HealthController],
            providers: [{ provide: DirectLineGateway, useValue: { stats: () => stats } }]
        }).compile();
        app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
        await app.init();
        await app.getHttpAdapter().getInstance().ready();
    });

    afterAll(() => app.close());

    const health = () => app.inject({ method: 'GET', url: '/health' });

    it('is ok while the WebSocket listener is up', async () => {
        const response = await health();
        expect(response.statusCode).toBe(200);
        expect(response.json()).toEqual({ status: 'ok', websocket: stats });
    });

    it('is unavailable while the WebSocket listener is down', async () => {
        stats.listening = false;
        const response = await health();
        expect(response.statusCode).toBe(503);
        expect(response.json()).toMatchObject({ status: 'unavailable', websocket: { listening: false } });
    });
});
