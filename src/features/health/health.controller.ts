import { Controller, Get } from '@nestjs/common';

@Controller('health')
export class HealthController {
    /**
     * GET /health
     * Liveness probe. Returns 200 while the process serves HTTP. Does not check DB, Redis, or the WebSocket server.
     */
    @Get()
    check(): { status: string } {
        return { status: 'ok' };
    }
}
