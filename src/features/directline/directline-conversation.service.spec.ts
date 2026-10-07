import { ConfigService } from '@nestjs/config';
import { HttpService } from '@nestjs/axios';
import { JwtService } from '@nestjs/jwt';
import { WebChatChannel } from 'src/entities/webchat.entity';
import { WebChatService } from '../channels/webchat/webchat.service';
import { AuthorizationService } from '../authorization/authorization.service';
import { OpenBotService } from '../openbot/openbot.service';
import { StorageService } from '../storage/storage.service';
import { AtomicOperationsService } from '../atomicity/atomic-operations.service';
import { DirectLineGateway } from './directline.gateway';
import { DirectlineTokenService } from './dirtectline-token.service';
import { DirectlineConversationService } from './directline-conversation.service';

describe('DirectlineConversationService', () => {
    const jwtService = new JwtService({ secret: 'test-secret' });
    const configService = {
        get: (key: string) => (key === 'DIRECTLINE_SOCKET_URL' ? 'ws://obf' : undefined)
    } as unknown as ConfigService;
    const site = {
        id: 'site1',
        secret1: 'site1.secret',
        secret2: 'site1.other',
        openBot: { handle: 'bot' }
    } as WebChatChannel;
    const webChatService = {
        findByIdCached: jest.fn((id: string) => Promise.resolve(id === site.id ? site : null))
    } as unknown as WebChatService;
    const tokenService = new DirectlineTokenService(webChatService, configService, jwtService);
    const service = new DirectlineConversationService(
        configService,
        {} as AuthorizationService,
        {} as OpenBotService,
        {} as HttpService,
        {} as DirectLineGateway,
        tokenService,
        {} as StorageService,
        {} as AtomicOperationsService
    );

    describe('createConversation', () => {
        it('starts a conversation from a webchat secret', async () => {
            const response = await service.createConversation({ user: { id: 'u1' } } as never, 'Bearer site1.secret');
            expect(response.streamUrl).toContain(`/conversations/${response.conversationId}/stream`);
        });
    });
});
