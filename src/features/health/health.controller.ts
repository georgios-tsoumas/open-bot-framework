import { Controller, Get, HttpStatus, Res } from '@nestjs/common';
import { FastifyReply } from 'fastify';
import { DirectLineGateway } from '../directline/directline.gateway';

@Controller('health')
export class HealthController {
    constructor(private readonly gateway: DirectLineGateway) {}

    /**
     * Readiness of both listeners. HTTP answering proves nothing about the stream endpoint, which binds its own
     * port, so the body carries the WebSocket listener state and counters and the status is 503 while it is down.
     */
    @Get()
    health(@Res({ passthrough: true }) reply: FastifyReply) {
        const websocket = this.gateway.stats();
        if (!websocket.listening) {
            reply.status(HttpStatus.SERVICE_UNAVAILABLE);
        }
        return { status: websocket.listening ? 'ok' : 'unavailable', websocket };
    }
}
