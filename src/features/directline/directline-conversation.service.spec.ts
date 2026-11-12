import { BadRequestException, ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { HttpService } from '@nestjs/axios';
import { JwtService } from '@nestjs/jwt';
import { Activity } from 'botframework-schema';
import { of, throwError } from 'rxjs';
import { WebChatChannel } from 'src/entities/webchat.entity';
import { WebChatService } from '../channels/webchat/webchat.service';
import { AuthorizationService } from '../authorization/authorization.service';
import { OpenBotService } from '../openbot/openbot.service';
import { StorageService } from '../storage/storage.service';
import { AtomicOperationsService } from '../atomicity/atomic-operations.service';
import { ConversationPublisher } from './conversation-publisher.service';
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
    const atomic = { incr: jest.fn().mockResolvedValue(1) };
    const publisher = { publish: jest.fn() };
    const authorizationService = { verifyBotToken: jest.fn().mockResolvedValue(undefined) };
    const http = { post: jest.fn().mockReturnValue(of({})) };
    const openBotService = { findByHandleCached: jest.fn().mockResolvedValue({ endpoint: 'http://bot' }) };
    const service = new DirectlineConversationService(
        configService,
        authorizationService as unknown as AuthorizationService,
        openBotService as unknown as OpenBotService,
        http as unknown as HttpService,
        publisher as unknown as ConversationPublisher,
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

        it('publishes the echo with its seq after the bot accepted it', async () => {
            await service.userReplyToConversation('conv1', activity(), validToken);
            expect(publisher.publish).toHaveBeenCalledWith(
                'conv1',
                expect.objectContaining({ id: 'conv1|0000001' }),
                1
            );
            expect(http.post.mock.invocationCallOrder[0]).toBeLessThan(publisher.publish.mock.invocationCallOrder[0]);
        });

        it('does not echo when the bot rejects the message', async () => {
            http.post.mockReturnValueOnce(throwError(() => new Error('bot down')));
            await expect(service.userReplyToConversation('conv1', activity(), validToken)).rejects.toThrow(
                BadRequestException
            );
            expect(publisher.publish).not.toHaveBeenCalled();
        });

        it('rejects an expired token with 403', async () => {
            await expect(service.userReplyToConversation('conv1', activity(), expiredToken)).rejects.toThrow(
                ForbiddenException
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

    describe('replyToActivity', () => {
        const botToken = 'Bearer bot-token';

        it('publishes a bot reply whose seq matches the id suffix', async () => {
            atomic.incr.mockResolvedValueOnce(42);
            const reply = { type: 'message', text: 'hello' } as Activity;
            await expect(service.replyToActivity('conv1', reply, botToken, 'conv1|0000041')).resolves.toEqual({
                id: 'conv1|0000042'
            });
            expect(publisher.publish).toHaveBeenCalledWith(
                'conv1',
                expect.objectContaining({ id: 'conv1|0000042', replyToId: 'conv1|0000041' }),
                42
            );
        });

        it('publishes typing without a seq and without taking a counter value', async () => {
            await service.replyToActivity('conv1', { type: 'typing' } as Activity, botToken);
            expect(atomic.incr).not.toHaveBeenCalled();
            expect(publisher.publish).toHaveBeenCalledWith('conv1', expect.objectContaining({ type: 'typing' }), null);
        });
    });

    describe('getConversation', () => {
        it('passes a numeric watermark into the stream URL and never touches the counter', () => {
            const response = service.getConversation('conv1', validToken, '5');
            expect(response.streamUrl).toContain('watermark=5&');
            expect(atomic.incr).not.toHaveBeenCalled();
        });

        it.each([undefined, '-', 'abc'])('uses watermark=- for %s', watermark => {
            const response = service.getConversation('conv1', validToken, watermark as string);
            expect(response.streamUrl).toContain('watermark=-&');
        });

        it('rejects a token for another conversation', () => {
            expect(() => service.getConversation('other-conv', validToken, '0')).toThrow(UnauthorizedException);
        });
    });
});
