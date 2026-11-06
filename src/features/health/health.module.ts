import { Module } from '@nestjs/common';
import { DirectlineModule } from '../directline/directline.module';
import { HealthController } from './health.controller';

@Module({
    imports: [DirectlineModule],
    controllers: [HealthController]
})
export class HealthModule {}
