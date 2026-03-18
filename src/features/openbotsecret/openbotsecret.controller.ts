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
    ValidationPipe,
    ParseUUIDPipe
} from '@nestjs/common';
import { OpenBotSecretService } from './openbotsecret.service';
import { OpenBotSecretDto } from 'src/dto/openbot.dto';
import { PaginatedTransform } from 'src/dto/page.dto';
import { JwtAuthGuard } from 'src/guards/jwt-auth.guard';

@Controller('bots/:botId/credentials')
@UseGuards(JwtAuthGuard)
@UsePipes(new ValidationPipe())
export class OpenBotSecretController {
    constructor(private readonly openbotsecretService: OpenBotSecretService) {}

    @Get()
    async findAll(
        @Param('botId', ParseUUIDPipe) botId: string,
        @Query('page', new DefaultValuePipe(0), ParseIntPipe) page: number,
        @Query('pageSize', new DefaultValuePipe(10), ParseIntPipe) pageSize: number
    ): Promise<PaginatedTransform<any, OpenBotSecretDto>> {
        return this.openbotsecretService.findAll(botId, page, pageSize);
    }

    @Get(':id')
    async findById(
        @Param('botId', ParseUUIDPipe) botId: string,
        @Param('id', ParseUUIDPipe) id: string
    ): Promise<OpenBotSecretDto> {
        return (await this.openbotsecretService.findByIdInOpenBot(botId, id)).toDto();
    }

    @Post()
    async create(
        @Param('botId', ParseUUIDPipe) botId: string,
        @Body() payload: OpenBotSecretDto
    ): Promise<OpenBotSecretDto> {
        return this.openbotsecretService.createBotSecret(botId, payload);
    }

    @Put(':id')
    async update(
        @Param('botId', ParseUUIDPipe) botId: string,
        @Param('id', ParseUUIDPipe) id: string,
        @Body() payload: Partial<OpenBotSecretDto>
    ): Promise<OpenBotSecretDto> {
        return this.openbotsecretService.update(botId, id, payload);
    }

    @Delete(':id')
    @HttpCode(HttpStatus.NO_CONTENT)
    async delete(@Param('botId', ParseUUIDPipe) botId: string, @Param('id', ParseUUIDPipe) id: string): Promise<void> {
        return this.openbotsecretService.delete(botId, id);
    }
}
