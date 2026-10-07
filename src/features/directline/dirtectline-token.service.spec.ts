import { UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { WebChatChannel } from 'src/entities/webchat.entity';
import { WebChatService } from '../channels/webchat/webchat.service';
import { DirectlineTokenService } from './dirtectline-token.service';

describe('DirectlineTokenService', () => {
    const jwtService = new JwtService({ secret: 'test-secret' });
    const configService = { get: () => undefined } as unknown as ConfigService;
    const site = {
        id: 'site1',
        secret1: 'site1.first-secret',
        secret2: 'site1.second-secret',
        openBot: { handle: 'bot' }
    } as WebChatChannel;
    const webChatService = {
        findByIdCached: jest.fn((id: string) => Promise.resolve(id === site.id ? site : null)),
        existsByIdCached: jest.fn((id: string) => Promise.resolve(id === site.id))
    } as unknown as WebChatService;
    const service = new DirectlineTokenService(webChatService, configService, jwtService);

    describe('generateToken', () => {
        it.each(['site1.first-secret', 'site1.second-secret'])('issues a token for %s', async secret => {
            const response = await service.generateToken(`Bearer ${secret}`);
            expect(service.verifyDirectLineToken(response.token, false).conv).toBe(response.conversationId);
        });

        it('rejects a made-up secret for a real site', async () => {
            await expect(service.generateToken('Bearer site1.anything')).rejects.toThrow(UnauthorizedException);
        });

        it('rejects an unknown site', async () => {
            await expect(service.generateToken('Bearer nope.first-secret')).rejects.toThrow(UnauthorizedException);
        });
    });
});
