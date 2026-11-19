import { Module } from '@nestjs/common';
import { HealthController } from './health.controller';
import { DrainStateService } from './drain-state.service';

@Module({
    controllers: [HealthController],
    providers: [DrainStateService],
    exports: [DrainStateService]
})
export class HealthModule {}
