import { UnauthorizedException } from '@nestjs/common';
import { Cache } from 'cache-manager';
import { Repository } from 'typeorm';
import { OpenBotSecret } from 'src/entities/openbot.entity';
import { OpenBotService } from '../openbot/openbot.service';
import { AuthorizationUtils } from '../authorization/authorization.utils';
import { OpenBotSecretService } from './openbotsecret.service';

describe('OpenBotSecretService', () => {
    const findOne = jest.fn();
    const repository = { findOne } as unknown as Repository<OpenBotSecret>;
    const cache = { wrap: (_key: string, fn: () => Promise<unknown>) => fn() } as unknown as Cache;
    const service = new OpenBotSecretService({} as OpenBotService, repository, cache);

    const secret = (expiresAt?: Date | string) =>
        ({ id: 'client-1', secretHash: AuthorizationUtils.createHash('plain'), expiresAt }) as OpenBotSecret;

    it('accepts a secret with no expiry', async () => {
        findOne.mockResolvedValue(secret());
        await expect(service.validateSecretCached('client-1', 'plain')).resolves.toBeUndefined();
    });

    it('accepts a secret that expires in the future', async () => {
        findOne.mockResolvedValue(secret(new Date(Date.now() + 60_000)));
        await expect(service.validateSecretCached('client-1', 'plain')).resolves.toBeUndefined();
    });

    it('rejects an expired secret, also when the cache returns the date as a string', async () => {
        findOne.mockResolvedValue(secret(new Date(Date.now() - 1000).toISOString()));
        await expect(service.validateSecretCached('client-1', 'plain')).rejects.toThrow(UnauthorizedException);
    });

    it('rejects a wrong secret', async () => {
        findOne.mockResolvedValue(secret());
        await expect(service.validateSecretCached('client-1', 'wrong')).rejects.toThrow(UnauthorizedException);
    });
});
