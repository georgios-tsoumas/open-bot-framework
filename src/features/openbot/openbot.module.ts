import { Module } from '@nestjs/common';
import { OpenBotService } from './openbot.service';
import { OpenBotController } from './openbot.controller';
import { TypeOrmModule } from '@nestjs/typeorm';
import { OpenBot } from 'src/entities/openbot.entity';
import { JwtAuthGuard } from 'src/guards/jwt-auth.guard';

@Module({
    imports: [TypeOrmModule.forFeature([OpenBot])],
    providers: [OpenBotService, JwtAuthGuard],
    controllers: [OpenBotController],
    exports: [TypeOrmModule]
})
export class OpenBotModule {}
