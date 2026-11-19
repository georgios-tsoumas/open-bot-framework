import { Module } from '@nestjs/common';
import { DirectlineConversationService } from './directline-conversation.service';
import { DirectlineController } from './directline.controller';
import { WebChatModule } from '../channels/webchat/webchat.module';
import { WebChatService } from '../channels/webchat/webchat.service';
import { AuthorizationModule } from '../authorization/authorization.module';
import { DirectLineGateway } from './directline.gateway';
import { HttpModule } from '@nestjs/axios';
import { DirectlineAltController } from './directline-alt.controller';
import { DirectlineTokenService } from './dirtectline-token.service';
import { StorageModule } from '../storage/storage.module';
import { StorageService } from '../storage/storage.service';
import { AtomicOperationsModule } from '../atomicity/atomic-operations.module';
import { AtomicOperationsService } from '../atomicity/atomic-operations.service';
import { HealthModule } from '../health/health.module';
import { ActivityStoreService } from './activity-store.service';
import { ConversationPublisher } from './conversation-publisher.service';

@Module({
    imports: [WebChatModule, AuthorizationModule, HttpModule, StorageModule, AtomicOperationsModule, HealthModule],
    providers: [
        DirectlineConversationService,
        WebChatService,
        DirectLineGateway,
        DirectlineTokenService,
        StorageService,
        AtomicOperationsService,
        ActivityStoreService,
        ConversationPublisher
    ],
    controllers: [DirectlineController, DirectlineAltController]
})
export class DirectlineModule {}
