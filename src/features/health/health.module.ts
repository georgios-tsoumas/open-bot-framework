import { Module } from '@nestjs/common';
import { HealthController } from './health.controller';
import { DrainStateService } from './drain-state.service';
import { SocketLoadService } from './socket-load.service';

@Module({
    controllers: [HealthController],
    providers: [DrainStateService, SocketLoadService],
    exports: [DrainStateService, SocketLoadService]
})
export class HealthModule {}
