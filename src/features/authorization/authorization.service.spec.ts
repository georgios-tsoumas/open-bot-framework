import { NotFoundException, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import { AuthorizationService } from './authorization.service';
import { OpenBotSecretService } from '../openbotsecret/openbotsecret.service';

describe('AuthorizationService', () => {
    const jwtService = new JwtService({ secret: 'test-secret' });
    const env: Record<string, string> = {
        ADMIN_USERNAME: 'admin',
        ADMIN_PASSWORD: bcrypt.hashSync('pw', 4)
    };
    const configService = { get: (key: string) => env[key] } as unknown as ConfigService;
    const findValidByIdCached = jest.fn();
    const openBotSecretService = {
        findValidByIdCached,
        validateSecretCached: jest.fn()
    } as unknown as OpenBotSecretService;
    const service = new AuthorizationService(jwtService, openBotSecretService, configService);

    const userToken = jwtService.sign({ bot: 'b', site: 's', conv: 'c' });

    beforeEach(() => {
        findValidByIdCached.mockReset();
    });

    describe('verifyAdminToken', () => {
        it('accepts a token from admin login', async () => {
            const { access_token } = await service.generateUserToken('admin', 'pw');
            expect(() => service.verifyAdminToken(access_token)).not.toThrow();
        });

        it('rejects a DirectLine user token', () => {
            expect(() => service.verifyAdminToken(userToken)).toThrow(UnauthorizedException);
        });

        it('rejects a bot client token', async () => {
            const { access_token } = await service.generateAccessToken('client-1', 'secret');
            expect(() => service.verifyAdminToken(access_token)).toThrow(UnauthorizedException);
        });

        it('rejects a token signed with another secret', () => {
            const forged = new JwtService({ secret: 'other' }).sign({ sub: 'admin', role: 'admin' });
            expect(() => service.verifyAdminToken(forged)).toThrow(UnauthorizedException);
        });
    });

    describe('verifyBotToken', () => {
        it('accepts a client credentials token for an existing credential', async () => {
            findValidByIdCached.mockResolvedValue({ id: 'client-1' });
            const { access_token } = await service.generateAccessToken('client-1', 'secret');
            await expect(service.verifyBotToken(access_token)).resolves.toBeUndefined();
            expect(findValidByIdCached).toHaveBeenCalledWith('client-1');
        });

        it('rejects a DirectLine user token', async () => {
            await expect(service.verifyBotToken(userToken)).rejects.toThrow(UnauthorizedException);
            expect(findValidByIdCached).not.toHaveBeenCalled();
        });

        it('rejects an admin token', async () => {
            const { access_token } = await service.generateUserToken('admin', 'pw');
            await expect(service.verifyBotToken(access_token)).rejects.toThrow(UnauthorizedException);
        });

        it('rejects a token whose credential was deleted or expired', async () => {
            findValidByIdCached.mockRejectedValue(new NotFoundException());
            const { access_token } = await service.generateAccessToken('client-1', 'secret');
            await expect(service.verifyBotToken(access_token)).rejects.toThrow(UnauthorizedException);
        });
    });
});
