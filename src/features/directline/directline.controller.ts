import {
    Body,
    Controller,
    Headers,
    Param,
    Post,
    HttpCode,
    Get,
    Query,
    Req,
    BadRequestException,
    HttpException
} from '@nestjs/common';
import { Activity, ConversationReference } from 'botframework-schema';
import { DirectLineTokenResponse } from 'src/dto/directline.dto';
import { DirectlineConversationService } from './directline-conversation.service';
import { ConversationResponse } from 'src/dto/conversation.dto';
import { DirectlineTokenService } from './dirtectline-token.service';
import { FastifyRequest } from 'fastify';
import { UploadDto } from 'src/dto/upload.dto';

@Controller('v3/directline')
export class DirectlineController {
    constructor(
        private readonly directLineService: DirectlineConversationService,
        private readonly directLineTokenService: DirectlineTokenService
    ) {}

    /**
     * Generate a DirectLine token from a web-chat secret.
     * Expects Authorization header with "Bearer <secret>".
     * Returns a DirectLineTokenResponse containing conversationId, token and expires_in.
     *
     * @param webChatSecret Authorization header value (Bearer webchat-secret)
     * @returns Promise<DirectLineTokenResponse>
     * @throws BadRequestException if header missing/invalid, UnauthorizedException on invalid secret
     */
    @Post('tokens/generate')
    @HttpCode(200)
    generateToken(@Headers('authorization') webChatSecret: string): Promise<DirectLineTokenResponse> {
        return this.directLineTokenService.generateToken(webChatSecret);
    }

    /**
     * Refresh an existing DirectLine token.
     * Expects Authorization header with "Bearer <token>".
     *
     * @param webChatSecret Authorization header value (Bearer token)
     * @returns Promise<DirectLineTokenResponse>
     * @throws BadRequestException if header missing/invalid, UnauthorizedException on invalid token
     */
    @Post('tokens/refresh')
    @HttpCode(200)
    refreshToken(@Headers('authorization') webChatSecret: string): Promise<DirectLineTokenResponse> {
        return this.directLineTokenService.refreshToken(webChatSecret);
    }

    /**
     * Create a new conversation for a user.
     * Expects a ConversationReference body and Authorization header (either secret or token).
     *
     * @param convRef ConversationReference payload (must contain user.id)
     * @param securityKey Authorization header containing the secret or token
     * @returns Promise<ConversationResponse> conversation metadata including token and streamUrl
     * @throws BadRequestException if inputs invalid, UnauthorizedException if key invalid
     */
    @Post('conversations')
    createConversation(
        @Body() convRef: ConversationReference,
        @Headers('authorization') securityKey: string
    ): Promise<ConversationResponse> {
        return this.directLineService.createConversation(convRef, securityKey);
    }

    /**
     * Retrieve conversation metadata (e.g. to open stream).
     * Expects Authorization header with DirectLine token and optional watermark.
     *
     * @param convId Conversation identifier
     * @param securityKey Authorization header value (Bearer token)
     * @param watermark Optional watermark to set activity increment
     * @returns ConversationResponse containing token, streamUrl and expires_in
     */
    @Get('conversations/:convId')
    getConversation(
        @Param('convId') convId: string,
        @Headers('authorization') securityKey: string,
        @Query('watermark') watermark: string
    ): Promise<ConversationResponse> {
        return this.directLineService.getConversation(convId, securityKey, watermark);
    }

    /**
     * Upload multipart payload to a conversation.
     * Expects multipart parts where first part name "activity" contains JSON activity,
     * and subsequent parts are named "file" (0..n).
     *
     * @param convId Conversation identifier to attach files/activity
     * @param securityKey Authorization header value (Bearer token/secret)
     * @param userId Optional userId query param used by service
     * @param req FastifyRequest to iterate parts
     * @returns Promise resolving to service result (e.g. conversation info or activity id)
     * @throws BadRequestException if required parts (activity) are missing or malformed
     */
    @Post('conversations/:convId/upload')
    async uploadToConversation(
        @Param('convId') convId: string,
        @Headers('authorization') securityKey: string,
        @Query('userId') userId: string,
        @Req() req: FastifyRequest
    ): Promise<unknown> {
        const parts = req.parts();
        const files: UploadDto[] = [];
        let activity: Activity | undefined = undefined;

        try {
            for await (const part of parts) {
                if (part.type === 'file') {
                    const buffer = await part.toBuffer();
                    if (part.fieldname === 'file') {
                        files.push({
                            filename: part.filename,
                            mimetype: part.mimetype,
                            fieldname: part.fieldname,
                            buffer
                        });
                    } else if (part.fieldname === 'activity') {
                        activity = this.parseActivity(buffer);
                    }
                }
            }
        } catch (e: unknown) {
            // Multipart limit errors (file too large, too many parts) carry their own 4xx status
            const statusCode = (e as { statusCode?: unknown }).statusCode;
            if (typeof statusCode === 'number' && statusCode >= 400 && statusCode < 500) {
                throw new HttpException((e as Error).message, statusCode);
            }
            throw e;
        }

        if (!activity) {
            throw new BadRequestException('Activity is missing from multipart');
        }
        return this.directLineService.userReplyToConversation(convId, activity, securityKey, files);
    }

    private parseActivity(buffer: Buffer): Activity {
        try {
            return JSON.parse(buffer.toString()) as Activity;
        } catch {
            throw new BadRequestException('Activity part is not valid JSON');
        }
    }

    /**
     * Create an activity in a conversation (user sent activity).
     * Expects a standard Activity JSON body and Authorization header (DirectLine token/secret).
     * Returns HTTP 200 with created activity id.
     *
     * @param convId Conversation identifier
     * @param activity Activity payload from client
     * @param securityKey Authorization header value (Bearer token/secret)
     * @returns Promise<unknown> typically { id: activityId }
     * @throws BadRequestException / UnauthorizedException on invalid inputs or token
     */
    @Post('conversations/:convId/activities')
    @HttpCode(200)
    createActivity(
        @Param('convId') convId: string,
        @Body() activity: Activity,
        @Headers('authorization') securityKey: string
    ): Promise<unknown> {
        return this.directLineService.userReplyToConversation(convId, activity, securityKey);
    }
}
