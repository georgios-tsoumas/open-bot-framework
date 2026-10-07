import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { HttpException, HttpStatus, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { OpenBotDto } from 'src/dto/openbot.dto';
import { PaginatedTransform } from 'src/dto/page.dto';
import { OpenBot } from 'src/entities/openbot.entity';
import { FindManyOptions, QueryFailedError } from 'typeorm';
import { Repository } from 'typeorm/repository/Repository';
import { Cache } from 'cache-manager';

@Injectable()
export class OpenBotService {
    constructor(
        @InjectRepository(OpenBot)
        private readonly openBotRepository: Repository<OpenBot>,
        @Inject(CACHE_MANAGER)
        private readonly cacheManager: Cache
    ) {}

    /**
     * Retrieve paginated list of OpenBot entities.
     *
     * @param page Page index (0-based)
     * @param pageSize Number of items per page
     * @returns PaginatedTransform of OpenBot entities to DTOs
     */
    async findAll(page: number, pageSize: number): Promise<PaginatedTransform<OpenBot, OpenBotDto>> {
        let selectSkip: FindManyOptions<OpenBot> = {};
        if (!isNaN(page) && !isNaN(pageSize)) {
            selectSkip = {
                take: pageSize,
                skip: page * pageSize
            } as FindManyOptions<OpenBot>;
        }
        return new PaginatedTransform(await this.openBotRepository.findAndCount(selectSkip), page, pageSize, d =>
            d.toDto()
        );
    }

    /**
     * Find a single OpenBot entity by its id.
     *
     * @param id OpenBot id
     * @returns OpenBot entity if found
     * @throws NotFoundException if no entity exists with provided id
     */
    async findById(id: string): Promise<OpenBot> {
        const openBot = await this.openBotRepository.findOneBy({ id });
        if (openBot) {
            return openBot;
        }
        throw new NotFoundException();
    }

    /**
     * Cached lookup for an OpenBot by handle.
     * Wraps repository access into cache to minimize DB hits.
     * Never expose in controller
     *
     * @param handle OpenBot handle string
     * @returns OpenBot entity
     * @throws NotFoundException if no entity exists with provided handle
     */
    async findByHandleCached(handle: string): Promise<OpenBot> {
        return this.cacheManager.wrap(
            handle,
            async () => {
                const openBot = await this.openBotRepository.findOneBy({ handle });
                if (openBot) {
                    return openBot;
                }
                throw new NotFoundException();
            },
            10_000
        );
    }

    /**
     * Create a new OpenBot entity from the provided DTO.
     *
     * @param openBotDto Data to persist
     * @returns OpenBotDto of the saved entity
     * @throws HttpException on DB constraint conflicts or persistence errors
     */
    async create(openBotDto: OpenBotDto): Promise<OpenBotDto> {
        const openBot = new OpenBot();
        openBot.handle = openBotDto.handle;
        openBot.endpoint = openBotDto.endpoint;
        openBot.schemaVersion = 'V1.3';
        try {
            return (await this.openBotRepository.save(openBot)).toDto();
        } catch (e: unknown) {
            if (e instanceof QueryFailedError) {
                const driverError = e as QueryFailedError & { constraint: string };
                if (driverError.constraint === 'IDX_OpenBot_handle') {
                    throw new HttpException('The handle provided already exists', HttpStatus.CONFLICT);
                }
            }
            throw new HttpException(`An error prevented this entity from persisting`, HttpStatus.INTERNAL_SERVER_ERROR);
        }
    }

    /**
     * Update an existing OpenBot entity.
     *
     * @param id OpenBot id to update
     * @param openBotDto Partial DTO containing updatable fields
     * @returns OpenBotDto updated representation
     */
    async update(id: string, openBotDto: Partial<OpenBotDto>): Promise<OpenBotDto> {
        const openBot = await this.findById(id);
        openBot.endpoint = openBotDto.endpoint ?? openBot.endpoint;
        openBot.schemaVersion = openBotDto.schemaVersion ?? openBot.schemaVersion;
        return (await this.openBotRepository.save(openBot)).toDto();
    }

    /**
     * Delete an OpenBot entity by id.
     *
     * @param id OpenBot id to delete
     * @returns void
     * @throws NotFoundException if entity does not exist
     */
    async delete(id: string): Promise<void> {
        const openBot = await this.findById(id);
        await this.openBotRepository.delete({ id: openBot.id });
    }
}
