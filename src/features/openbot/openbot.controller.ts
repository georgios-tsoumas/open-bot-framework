import {
    Controller,
    Get,
    Post,
    Put,
    Delete,
    Param,
    Body,
    Query,
    ParseIntPipe,
    DefaultValuePipe,
    HttpCode,
    HttpStatus,
    UsePipes,
    UseGuards,
    ValidationPipe
} from '@nestjs/common';
import { OpenBotService } from './openbot.service';
import { OpenBotDto } from 'src/dto/openbot.dto';
import { PaginatedTransform } from 'src/dto/page.dto';
import { JwtAuthGuard } from 'src/guards/jwt-auth.guard';

@Controller('bots')
@UseGuards(JwtAuthGuard)
@UsePipes(new ValidationPipe())
export class OpenBotController {
    constructor(private readonly openBotService: OpenBotService) {}

    /**
     * GET /bots?page=0&pageSize=10
     * Returns a paginated list of bots.
     */
    @Get()
    async findAll(
        @Query('page', new DefaultValuePipe(0), ParseIntPipe) page: number,
        @Query('pageSize', new DefaultValuePipe(10), ParseIntPipe) pageSize: number
    ): Promise<PaginatedTransform<any, OpenBotDto>> {
        return this.openBotService.findAll(page, pageSize);
    }

    /**
     * GET /bots/:id
     * Retrieves a single bot by its ID.
     */
    @Get(':id')
    async findById(@Param('id') id: string): Promise<OpenBotDto> {
        return (await this.openBotService.findById(id)).toDto();
    }

    /**
     * POST /bots
     * Creates a new bot entry.
     */
    @Post()
    async create(@Body() openBotDto: OpenBotDto): Promise<OpenBotDto> {
        return this.openBotService.create(openBotDto);
    }

    /**
     * PUT /bots/:id
     * Updates an existing bot by ID.
     */
    @Put(':id')
    async update(@Param('id') id: string, @Body() openBotDto: Partial<OpenBotDto>): Promise<OpenBotDto> {
        return this.openBotService.update(id, openBotDto);
    }

    /**
     * DELETE /bots/:id
     * Deletes a bot by ID.
     */
    @Delete(':id')
    @HttpCode(HttpStatus.NO_CONTENT)
    async delete(@Param('id') id: string): Promise<void> {
        return this.openBotService.delete(id);
    }
}
