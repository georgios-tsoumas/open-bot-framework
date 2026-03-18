import { Module } from '@nestjs/common';
import { WebChatController } from './webchat.controller';
import { WebChatService } from './webchat.service';
import { OpenBotModule } from 'src/features/openbot/openbot.module';
import { TypeOrmModule } from '@nestjs/typeorm';
import { WebChatChannel } from 'src/entities/webchat.entity';
import { OpenBotService } from 'src/features/openbot/openbot.service';
import { JwtAuthGuard } from 'src/guards/jwt-auth.guard';

@Module({
    imports: [OpenBotModule, TypeOrmModule.forFeature([WebChatChannel])],
    controllers: [WebChatController],
    providers: [WebChatService, OpenBotService, JwtAuthGuard],
    exports: [OpenBotService, TypeOrmModule]
})
export class WebChatModule {}
