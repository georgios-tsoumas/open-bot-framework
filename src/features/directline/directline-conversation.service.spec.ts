import { BadRequestException, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { HttpService } from '@nestjs/axios';
import { JwtService } from '@nestjs/jwt';
import { Activity } from 'botframework-schema';
import { of } from 'rxjs';
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
    const atomic = { set: jest.fn(), incr: jest.fn().mockResolvedValue(1), get: jest.fn().mockResolvedValue(1) };
    const gateway = { sendToConversation: jest.fn() };
    const http = { post: jest.fn().mockReturnValue(of({})) };
    const openBotService = { findByHandleCached: jest.fn().mockResolvedValue({ endpoint: 'http://bot' }) };
    const service = new DirectlineConversationService(
        configService,
        {} as AuthorizationService,
        openBotService as unknown as OpenBotService,
        http as unknown as HttpService,
        gateway as unknown as DirectLineGateway,
        tokenService,
        {} as StorageService,
        atomic as unknown as AtomicOperationsService
    );
    const payload = { bot: 'bot', site: 'site1', conv: 'conv1' };
    const validToken = `Bearer ${tokenService.createToken(payload, 60)}`;
    const expiredToken = `Bearer ${tokenService.createToken(payload, -10)}`;

    beforeEach(() => {
        jest.clearAllMocks();
    });

    describe('createConversation', () => {
        it('starts a conversation from a webchat secret', async () => {
            const response = await service.createConversation({ user: { id: 'u1' } } as never, 'Bearer site1.secret');
            expect(response.streamUrl).toContain(`/conversations/${response.conversationId}/stream`);
        });

        it('rejects a request with no body', async () => {
            await expect(service.createConversation(undefined as never, validToken)).rejects.toThrow(
                BadRequestException
            );
        });
    });

    describe('userReplyToConversation', () => {
        const activity = () => ({ type: 'message', text: 'hi' }) as Activity;

        it('forwards a message to the bot', async () => {
            await expect(service.userReplyToConversation('conv1', activity(), validToken)).resolves.toEqual({
                id: 'conv1|0000001'
            });
            expect(http.post).toHaveBeenCalledWith('http://bot', expect.anything(), expect.anything());
        });

        it('rejects an expired token', async () => {
            await expect(service.userReplyToConversation('conv1', activity(), expiredToken)).rejects.toThrow(
                UnauthorizedException
            );
            expect(http.post).not.toHaveBeenCalled();
        });

        it.each([null, 'abc', 42, []])('rejects a non-object body (%p)', async body => {
            await expect(service.userReplyToConversation('conv1', body as never, validToken)).rejects.toThrow(
                BadRequestException
            );
            expect(http.post).not.toHaveBeenCalled();
        });
    });

    describe('getConversation', () => {
        it('resets the counter to a numeric watermark', async () => {
            await service.getConversation('conv1', validToken, '5');
            expect(atomic.set).toHaveBeenCalledWith('conv1', 5);
        });

        it.each([undefined, '-', 'abc'])('leaves the counter alone for watermark %s', async watermark => {
            await service.getConversation('conv1', validToken, watermark as string);
            expect(atomic.set).not.toHaveBeenCalled();
        });

        it("rejects a token for another conversation and does not touch that conversation's counter", async () => {
            await expect(service.getConversation('other-conv', validToken, '0')).rejects.toThrow(UnauthorizedException);
            expect(atomic.set).not.toHaveBeenCalled();
        });
    });
});
