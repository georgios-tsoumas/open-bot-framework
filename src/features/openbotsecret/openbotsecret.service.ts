import { Inject, Injectable, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { OpenBotSecretDto } from 'src/dto/openbot.dto';
import { OpenBotSecret } from 'src/entities/openbot.entity';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, FindManyOptions } from 'typeorm';
import { OpenBotService } from '../openbot/openbot.service';
import { PaginatedTransform } from 'src/dto/page.dto';
import { AuthorizationUtils } from '../authorization/authorization.utils';
import { Cache } from 'cache-manager';
import { CACHE_MANAGER } from '@nestjs/cache-manager';

@Injectable()
export class OpenBotSecretService {
    constructor(
        private readonly openBotService: OpenBotService,
        @InjectRepository(OpenBotSecret)
        private readonly openBotSecretRepository: Repository<OpenBotSecret>,
        @Inject(CACHE_MANAGER)
        private readonly cacheManager: Cache
    ) {}

    /**
     * List secrets for a given bot with optional pagination.
     *
     * @param botId Parent OpenBot id
     * @param page Page index (0-based)
     * @param pageSize Number of items per page
     * @returns PaginatedTransform of OpenBotSecret entities to DTOs
     */
    async findAll(
        botId: string,
        page: number,
        pageSize: number
    ): Promise<PaginatedTransform<OpenBotSecret, OpenBotSecretDto>> {
        let selectSkip: FindManyOptions<OpenBotSecret> = {};
        const openBot = await this.openBotService.findById(botId);
        if (!isNaN(page) && !isNaN(pageSize)) {
            selectSkip = {
                where: {
                    openBot: { id: openBot.id }
                },
                take: pageSize,
                skip: page * pageSize
            } as FindManyOptions<OpenBotSecret>;
        }
        return new PaginatedTransform(await this.openBotSecretRepository.findAndCount(selectSkip), page, pageSize, d =>
            d.toDto()
        );
    }

    /**
     * Find a secret by id within the specified OpenBot.
     *
     * @param botId Parent OpenBot id
     * @param id Secret id to retrieve
     * @returns OpenBotSecret entity
     * @throws NotFoundException if secret not found
     */
    async findByIdInOpenBot(botId: string, id: string): Promise<OpenBotSecret> {
        const openBot = await this.openBotService.findById(botId);
        // query by secret id and the related openBot id
        const secret = await this.openBotSecretRepository.findOne({ where: { id, openBot: { id: openBot.id } } });
        if (secret) return secret;
        throw new NotFoundException();
    }

    /**
     * Cached lookup for a secret by its id. Used internally by other services for validation.
     * Never expose in controller
     *
     * @param id Secret id
     * @returns OpenBotSecret entity
     * @throws NotFoundException if not found
     */
    async findByIdCached(id: string): Promise<OpenBotSecret> {
        return this.cacheManager.wrap(
            id,
            async () => {
                const secret = await this.openBotSecretRepository.findOne({ where: { id } });
                if (secret) return secret;
                throw new NotFoundException();
            },
            10
        );
    }

    /**
     * Cached lookup for a secret that has not expired.
     * Never expose in controller
     *
     * @param id Secret id
     * @returns OpenBotSecret entity
     * @throws NotFoundException if not found, UnauthorizedException if expired
     */
    async findValidByIdCached(id: string): Promise<OpenBotSecret> {
        const openBotSecret = await this.findByIdCached(id);
        // The cache may hand back a serialized date, so normalize before comparing
        if (openBotSecret.expiresAt && new Date(openBotSecret.expiresAt).getTime() <= Date.now()) {
            throw new UnauthorizedException('Secret expired');
        }
        return openBotSecret;
    }

    /**
     * Create and persist a new OpenBotSecret associated with the given bot.
     * Generates a random plain secret, stores a hash and returns the DTO including the plain secret (once).
     *
     * @param botId Parent OpenBot id
     * @param payload DTO containing description/expiresAt
     * @returns OpenBotSecretDto containing redacted/plain secret info
     */
    async createBotSecret(botId: string, payload: OpenBotSecretDto): Promise<OpenBotSecretDto> {
        const openBot = await this.openBotService.findById(botId);
        const botSecret = new OpenBotSecret();
        botSecret.openBot = openBot;
        botSecret.description = payload.description;
        const secretPlain = AuthorizationUtils.generateRandom(40);
        botSecret.secretHash = AuthorizationUtils.createHash(secretPlain);
        botSecret.plainReducted = secretPlain.slice(0, 3);
        const savedBotSecret = await this.openBotSecretRepository.save(botSecret);
        return savedBotSecret.toDto(secretPlain);
    }

    /**
     * Update an existing secret's metadata.
     *
     * @param botId Parent OpenBot id
     * @param id Secret id to update
     * @param payload Partial DTO with updatable fields
     * @returns Updated OpenBotSecretDto
     */
    async update(botId: string, id: string, payload: Partial<OpenBotSecretDto>): Promise<OpenBotSecretDto> {
        const secret = await this.findByIdInOpenBot(botId, id);
        secret.description = payload.description ?? secret.description;
        secret.expiresAt = payload.expiresAt ?? secret.expiresAt;
        const saved = await this.openBotSecretRepository.save(secret);
        return saved.toDto();
    }

    /**
     * Delete a secret belonging to a bot.
     *
     * @param botId Parent OpenBot id
     * @param id Secret id to delete
     */
    async delete(botId: string, id: string): Promise<void> {
        const secret = await this.findByIdInOpenBot(botId, id);
        await this.openBotSecretRepository.delete({ id: secret.id });
    }

    /**
     * Validate a provided secret (plain text) against the stored hash for a given client id.
     * Uses cached lookup for performance.
     *
     * @param clientId Secret id (OpenBotSecret id)
     * @param clientSecretPlain Plain secret to validate
     * @throws UnauthorizedException if secret does not match
     */
    async validateSecretCached(clientId: string, clientSecretPlain: string) {
        const openBotSecret = await this.findValidByIdCached(clientId);
        if (openBotSecret.secretHash !== AuthorizationUtils.createHash(clientSecretPlain)) {
            throw new UnauthorizedException('Wrong secret provided');
        }
    }
}
