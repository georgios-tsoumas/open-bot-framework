import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { WebChatChannelDto } from 'src/dto/webchat.dto';
import { WebChatChannel } from 'src/entities/webchat.entity';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, FindManyOptions } from 'typeorm';
import { OpenBotService } from '../../openbot/openbot.service';
import { PaginatedTransform } from 'src/dto/page.dto';
import { AuthorizationUtils } from 'src/features/authorization/authorization.utils';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { Cache } from 'cache-manager';

@Injectable()
export class WebChatService {
    constructor(
        private readonly openBotService: OpenBotService,
        @InjectRepository(WebChatChannel)
        private readonly webchatRepository: Repository<WebChatChannel>,
        @Inject(CACHE_MANAGER) private cacheManager: Cache
    ) {}

    /**
     * Find all webchat channels for a bot with optional pagination.
     *
     * @param botId - ID of the bot whose channels should be returned.
     * @param page - Zero-based page index. If NaN, pagination is not applied.
     * @param pageSize - Page size. If NaN, pagination is not applied.
     * @returns A PaginatedTransform wrapping the channels and DTO mapping.
     * @throws If the referenced bot cannot be found (propagated from openBotService).
     */
    async findAll(
        botId: string,
        page: number,
        pageSize: number
    ): Promise<PaginatedTransform<WebChatChannel, WebChatChannelDto>> {
        let selectSkip: FindManyOptions<WebChatChannel> = {};
        const openBot = await this.openBotService.findById(botId);
        if (!isNaN(page) && !isNaN(pageSize)) {
            selectSkip = {
                where: {
                    openBot: { id: openBot.id }
                },
                take: pageSize,
                skip: page * pageSize
            } as FindManyOptions<WebChatChannel>;
        }
        return new PaginatedTransform(await this.webchatRepository.findAndCount(selectSkip), page, pageSize, d =>
            d.toDto()
        );
    }

    /**
     * Find a WebChatChannel by its ID.
     * Never expose in controller
     *
     * @param id - Channel ID.
     * @param relations - Optional array of relation names to load.
     * @returns The WebChatChannel or null if not found.
     */
    async findById(id: string, relations?: string[]): Promise<WebChatChannel | null> {
        return this.webchatRepository.findOne({ relations, where: { id } });
    }

    /**
     * Find a WebChatChannel by ID using the cache.
     * Never expose in controller
     *
     * @param id - Channel ID.
     * @param relations - Optional relations to include in the cache key and load.
     * @returns The WebChatChannel or null if not found.
     */
    async findByIdCached(id: string, relations?: string[]): Promise<WebChatChannel | null> {
        const key = `webchat:${id}:${(relations ?? []).join(',')}`;
        const cached = await this.cacheManager.get<WebChatChannel>(key);
        if (cached) {
            return cached;
        }
        // Misses are not cached: the id comes from the caller, so anyone could fill the cache with made-up ids
        const channel = await this.findById(id, relations);
        if (channel) {
            await this.cacheManager.set(key, channel, 10_000);
        }
        return channel;
    }

    /**
     * Check whether a WebChatChannel exists by ID.
     * Never expose in controller
     *
     * @param id - Channel ID.
     * @returns True if the channel exists, false otherwise.
     */
    async existsById(id: string): Promise<boolean> {
        return this.webchatRepository.exists({ where: { id } });
    }

    /**
     * Check whether a WebChatChannel exists by ID using cache.
     *
     * @param id - Channel ID used as cache key.
     * @returns True if the channel exists, false otherwise.
     */
    async existsByIdCached(id: string): Promise<boolean> {
        return this.cacheManager.wrap(id, () => this.webchatRepository.exists({ where: { id } }), 10_000);
    }

    /**
     * Find a WebChatChannel by ID and ensure it belongs to the specified bot.
     *
     * @param botId - ID of the bot.
     * @param id - Channel ID.
     * @returns The WebChatChannel if found and belongs to the bot.
     * @throws NotFoundException if the channel is not found within the bot.
     */
    async findByIdInBot(botId: string, id: string): Promise<WebChatChannel> {
        const openBot = await this.openBotService.findById(botId);
        const channel = await this.webchatRepository.findOne({ where: { id, openBot: { id: openBot.id } } });
        if (channel) return channel;
        throw new NotFoundException();
    }

    /**
     * Create a new webchat channel with generated secrets and return its DTO.
     *
     * @param botId - ID of the bot to attach the channel to.
     * @param payload - Partial DTO containing initial name and other optional fields.
     * @returns The created channel mapped to WebChatChannelDto.
     * @throws If the referenced bot cannot be found (propagated from openBotService).
     */
    async createBotSecret(botId: string, payload: WebChatChannelDto): Promise<WebChatChannelDto> {
        const openBot = await this.openBotService.findById(botId);
        const channel = new WebChatChannel();
        channel.id = AuthorizationUtils.generateRandom(11);
        channel.openBot = openBot;
        channel.name = payload.name;
        channel.secret1 = AuthorizationUtils.createWebChatSecret(channel.id);
        channel.secret2 = AuthorizationUtils.createWebChatSecret(channel.id);
        const saved = await this.webchatRepository.save(channel);
        return saved.toDto();
    }

    /**
     * Update a webchat channel fields (name and optionally regenerate secrets).
     *
     * - Setting payload.secret1 or payload.secret2 to null will regenerate that secret.
     * - Omitting fields will keep existing values.
     *
     * @param botId - ID of the bot that owns the channel.
     * @param id - Channel ID.
     * @param payload - Partial DTO with update values.
     * @returns The updated channel mapped to WebChatChannelDto.
     * @throws NotFoundException if the channel does not exist in the bot.
     */
    async update(botId: string, id: string, payload: Partial<WebChatChannelDto>): Promise<WebChatChannelDto> {
        const channel = await this.findByIdInBot(botId, id);
        channel.name = payload.name ?? channel.name;
        channel.secret1 =
            payload.secret1 === null ? AuthorizationUtils.createWebChatSecret(channel.id) : channel.secret1;
        channel.secret2 =
            payload.secret2 === null ? AuthorizationUtils.createWebChatSecret(channel.id) : channel.secret2;
        const saved = await this.webchatRepository.save(channel);
        return saved.toDto();
    }

    /**
     * Delete a webchat channel identified by id belonging to the given bot.
     *
     * @param botId - ID of the bot that owns the channel.
     * @param id - Channel ID.
     * @returns Promise that resolves when deletion is complete.
     * @throws NotFoundException if the channel does not exist in the bot.
     */
    async delete(botId: string, id: string): Promise<void> {
        const channel = await this.findByIdInBot(botId, id);
        await this.webchatRepository.delete({ id: channel.id });
    }
}
