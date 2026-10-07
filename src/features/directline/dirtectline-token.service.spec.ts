import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
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
            expect(service.verifyDirectLineToken(response.token).conv).toBe(response.conversationId);
        });

        it('rejects a made-up secret for a real site', async () => {
            await expect(service.generateToken('Bearer site1.anything')).rejects.toThrow(UnauthorizedException);
        });

        it('rejects an unknown site', async () => {
            await expect(service.generateToken('Bearer nope.first-secret')).rejects.toThrow(UnauthorizedException);
        });
    });

    describe('refreshToken', () => {
        const payload = { bot: 'bot', site: 'site1', conv: 'conv1', user: 'u1' };

        it('refreshes a valid token for the same conversation', async () => {
            const response = await service.refreshToken(`Bearer ${service.createToken(payload, 60)}`);
            expect(service.verifyDirectLineToken(response.token)).toMatchObject(payload);
        });

        it('rejects an expired token with 403 (what DirectLine clients expect)', async () => {
            await expect(service.refreshToken(`Bearer ${service.createToken(payload, -10)}`)).rejects.toThrow(
                ForbiddenException
            );
        });
    });

    describe('verifyDirectLineToken', () => {
        it.each([
            ['an admin token', { sub: 'admin', role: 'admin' }],
            ['a bot token', { sub: 'client-1', aud: 'https://api.botframework.com/.default' }]
        ])('rejects %s signed with the same secret', (_label, claims) => {
            expect(() => service.verifyDirectLineToken(jwtService.sign(claims))).toThrow(UnauthorizedException);
        });
    });
});
