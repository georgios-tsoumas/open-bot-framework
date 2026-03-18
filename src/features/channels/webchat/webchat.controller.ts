import {
    Controller,
    Get,
    Post,
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
    ParseUUIDPipe,
    Patch
} from '@nestjs/common';
import { WebChatService } from './webchat.service';
import { WebChatChannelDto } from 'src/dto/webchat.dto';
import { PaginatedTransform } from 'src/dto/page.dto';
import { JwtAuthGuard } from 'src/guards/jwt-auth.guard';

@Controller('bots/:botId/webchat')
@UseGuards(JwtAuthGuard)
@UsePipes(new ValidationPipe())
export class WebChatController {
    constructor(private readonly webchatService: WebChatService) {}

    @Get()
    async findAll(
        @Param('botId', ParseUUIDPipe) botId: string,
        @Query('page', new DefaultValuePipe(0), ParseIntPipe) page: number,
        @Query('pageSize', new DefaultValuePipe(10), ParseIntPipe) pageSize: number
    ): Promise<PaginatedTransform<any, WebChatChannelDto>> {
        return this.webchatService.findAll(botId, page, pageSize);
    }

    @Get(':id')
    async findById(
        @Param('botId', ParseUUIDPipe) botId: string,
        @Param('id', ParseUUIDPipe) id: string
    ): Promise<WebChatChannelDto> {
        return (await this.webchatService.findByIdInBot(botId, id)).toDto();
    }

    @Post()
    async create(
        @Param('botId', ParseUUIDPipe) botId: string,
        @Body() payload: WebChatChannelDto
    ): Promise<WebChatChannelDto> {
        return this.webchatService.createBotSecret(botId, payload);
    }

    @Patch(':id')
    async update(
        @Param('botId', ParseUUIDPipe) botId: string,
        @Param('id', ParseUUIDPipe) id: string,
        @Body() payload: Partial<WebChatChannelDto>
    ): Promise<WebChatChannelDto> {
        return this.webchatService.update(botId, id, payload);
    }

    @Delete(':id')
    @HttpCode(HttpStatus.NO_CONTENT)
    async delete(@Param('botId', ParseUUIDPipe) botId: string, @Param('id', ParseUUIDPipe) id: string): Promise<void> {
        return this.webchatService.delete(botId, id);
    }
}
