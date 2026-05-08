import { BadRequestException, Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { Activity, ConversationReference, Transcript } from 'botframework-schema';
import { DirectLineTokenPayload } from 'src/dto/directline.dto';
import { AuthorizationUtils } from '../authorization/authorization.utils';
import { ConfigService } from '@nestjs/config';
import { AuthorizationService } from '../authorization/authorization.service';
import { ConversationResponse } from 'src/dto/conversation.dto';
import { OpenBotService } from '../openbot/openbot.service';
import { HttpService } from '@nestjs/axios';
import { lastValueFrom } from 'rxjs';
import { DirectLineGateway } from './directline.gateway';
import { DirectlineTokenService } from './dirtectline-token.service';
import { StorageService } from '../storage/storage.service';
import { UploadDto } from 'src/dto/upload.dto';
import { AtomicOperationsService } from '../atomicity/atomic-operations.service';

@Injectable()
export class DirectlineConversationService {
    private readonly expires: number;
    private readonly host: string;
    private readonly socketUrl: string;
    private readonly logger = new Logger(this.constructor.name);

    constructor(
        private readonly configService: ConfigService,
        private readonly authorizationService: AuthorizationService,
        private readonly openBotService: OpenBotService,
        private readonly httpService: HttpService,
        private readonly socketGateway: DirectLineGateway,
        private readonly directLineTokenService: DirectlineTokenService,
        private readonly storageService: StorageService,
        private readonly atomicOperationService: AtomicOperationsService
    ) {
        this.expires = Number(this.configService.get<number | string>('JWT_EXPIRATION_SECONDS')) || 3600;
        // Populate host from env/config
        this.host = String(this.configService.get<string>('DIRECTLINE_HOST') ?? '') || '';
        this.socketUrl = String(this.configService.get<string>('DIRECTLINE_SOCKET_URL') ?? '') || '';
    }

    /**
     * Create a conversation for a user based on either a DirectLine token or a site secret.
     *
     * @param convRef ConversationReference (must contain convRef.user.id)
     * @param authorizationHeader Authorization header value (Bearer token or secret)
     * @returns ConversationResponse with conversationId, token, expires_in and streamUrl
     * @throws BadRequestException when inputs invalid; UnauthorizedException when key is invalid
     */
    async createConversation(
        convRef: ConversationReference,
        authorizationHeader: string
    ): Promise<ConversationResponse> {
        const securityKey = AuthorizationUtils.removeBearer(authorizationHeader);
        if (!securityKey) {
            throw new BadRequestException('Wrong type of token provided. Provide Bearer');
        }
        if (!convRef.user?.id) {
            throw new BadRequestException('No user provided');
        }

        // Identify type of security key
        const dots = this.countDots(securityKey);
        // JWT token (need to avoid the costly verify method)
        if (dots === 2) {
            const validPayload = this.directLineTokenService.verifyDirectLineToken(securityKey, false);
            const newPayload: DirectLineTokenPayload = {
                bot: validPayload.bot,
                site: validPayload.site,
                conv: validPayload.conv,
                user: convRef.user.id
            };
            const token = this.directLineTokenService.createToken(newPayload, this.expires);
            const conversationId = validPayload.conv;
            this.logger.verbose(`Created conversation ${conversationId}`);
            return {
                conversationId,
                expires_in: this.expires,
                token,
                streamUrl: this.generateStreamUrl(conversationId, token)
            };
        }

        // Secret provided
        if (dots === 1) {
            const tokenResponse = await this.directLineTokenService.generateToken(securityKey, convRef.user.id);
            const conversationId = tokenResponse.conversationId;
            const { token } = tokenResponse;
            return {
                ...tokenResponse,
                streamUrl: this.generateStreamUrl(conversationId, token)
            };
        }

        throw new UnauthorizedException();
    }

    /**
     * Return conversation metadata and set the watermark used for subsequent activity numbering.
     *
     * @param conversationId Conversation identifier
     * @param authorizationHeader Authorization header containing directline token
     * @param watermark Optional watermark string that will be stored as numeric watermark
     * @returns ConversationResponse with token and stream URL
     * @throws BadRequestException if header missing/invalid
     */
    async getConversation(
        conversationId: string,
        authorizationHeader: string,
        watermark: string
    ): Promise<ConversationResponse> {
        const securityKey = AuthorizationUtils.removeBearer(authorizationHeader);
        if (!securityKey) {
            throw new BadRequestException('Wrong type of token provided. Provide Bearer');
        }
        this.directLineTokenService.verifyDirectLineToken(securityKey, false);
        await this.atomicOperationService.set(conversationId, Number(watermark));
        return {
            conversationId,
            expires_in: this.expires,
            token: securityKey,
            streamUrl: this.generateStreamUrl(conversationId, securityKey, watermark)
        };
    }

    /**
     * Handle a user-originated reply to a conversation. Validates token, optionally uploads files,
     * forwards the activity to the target bot endpoint and emits the activity over websockets.
     *
     * @param conversationId Conversation identifier
     * @param activity Activity payload from user
     * @param authorizationHeader Authorization header value (Bearer token)
     * @param files Optional array of uploaded files to persist and attach to activity
     * @returns Promise resolving with created activity id container object
     * @throws BadRequestException / UnauthorizedException on invalid inputs or delivery failures
     */
    async userReplyToConversation(
        conversationId: string,
        activity: Activity,
        authorizationHeader: string,
        files?: UploadDto[]
    ): Promise<unknown> {
        const token = AuthorizationUtils.removeBearer(authorizationHeader);
        if (!token) {
            throw new BadRequestException('Wrong type of token provided. Provide Bearer');
        }
        // Validate signature
        const validPayload = this.directLineTokenService.verifyDirectLineToken(token, true);
        if (conversationId !== validPayload.conv) {
            throw new UnauthorizedException('Token does not belong to this conversation');
        }

        // Set bot recipient
        activity.recipient = { id: `${validPayload.bot}@${validPayload.site}`, name: validPayload.bot };
        const newActivity = await this.createActivity(conversationId, activity, files);

        // Get bot for event endpoint
        const targetBot = await this.openBotService.findByHandleCached(validPayload.bot);

        // Push payload to event endpoint (needs queue)
        try {
            await lastValueFrom(
                this.httpService.post(targetBot.endpoint, newActivity, {
                    headers: { 'Content-Type': 'application/json' },
                    timeout: 5000
                })
            );
            // Prepare the transcript and push to the live wire (does not require watermark)
            this.logger.verbose(`User sends type: ${newActivity.type}, text: ${newActivity.text}`);
            const transcript: Transcript = {
                activities: [newActivity]
            };
            await this.socketGateway.sendToConversation(conversationId, transcript);
            return { id: newActivity.id };
        } catch (err) {
            throw new BadRequestException(`Failed to post to bot endpoint: ${err}`);
        }
    }

    /**
     * Process a bot-originated reply (server side). Validates server-side access token and
     * produces an activity that is broadcast to clients (and optionally persisted).
     *
     * @param conversationId Conversation id
     * @param activity Activity payload being sent by bot
     * @param authorizationHeader Server access token header
     * @param replyToActivity Optional activity id this message replies to. Omitted for non-reply
     *        sends (Bot Framework `POST /v3/conversations/{conversationId}/activities`) used by
     *        livechat agents and bot-initiated messages.
     * @returns Promise resolving with { id: newActivity.id }
     */
    async replyToActivity(
        conversationId: string,
        activity: Activity,
        authorizationHeader: string,
        replyToActivity?: string
    ) {
        const token = AuthorizationUtils.removeBearer(authorizationHeader);
        if (!token) {
            throw new BadRequestException('Wrong type of token provided. Provide Bearer');
        }
        // Validate signature
        this.authorizationService.verifyAccessToken(token);

        if (replyToActivity) {
            activity.replyToId = replyToActivity;
        }

        // Create the activity
        const newActivity = await this.createActivity(conversationId, activity);

        // Prepare the transcript and push to the live wire (requires watermark)
        const transcript: Transcript & { watermark: string | undefined } = {
            activities: [newActivity],
            watermark:
                newActivity.type !== 'typing'
                    ? String(await this.atomicOperationService.get(conversationId))
                    : undefined
        };
        this.logger.verbose(`Bot replies with type: ${newActivity.type}, text: ${newActivity.text}`);
        await this.socketGateway.sendToConversation(conversationId, transcript);
        return { id: newActivity.id };
    }

    /**
     * Internal helper to create an activity object: assign id, timestamp, serviceUrl and conversation.
     * When files are provided they are uploaded and attachments updated prior to id assignment.
     *
     * @param conversationId Conversation id for id generation and object pathing
     * @param activity Activity object to enrich (mutated in place and returned)
     * @param files Optional array of UploadDto to persist and attach
     * @returns Enriched Activity ready to be forwarded to bot or clients
     */
    private async createActivity(conversationId: string, activity: Activity, files?: UploadDto[]) {
        if (files) {
            await this.storageService.uploadToActivity(files, conversationId, activity);
        }

        // Logic is flawed. Microsoft increases activity id based on some other criterion
        if (activity.type !== 'typing') {
            const counter = String(await this.atomicOperationService.incr(conversationId));
            const padded = counter.padStart(7, '0');
            activity.id = `${conversationId}|${padded}`;
        } else {
            activity.id = `${conversationId}|${AuthorizationUtils.generateRandom(11)}`;
        }

        // Timestamp
        activity.timestamp = new Date();

        // Service url
        activity.serviceUrl = this.host;

        // Append Conversation
        activity.conversation = { id: conversationId, isGroup: false, conversationType: '', name: '' };

        return activity;
    }

    /**
     * Count number of '.' characters in a token string.
     *
     * @param token Token string to inspect
     * @returns number of dot characters found
     */
    private countDots(token: string): number {
        let count = 0;
        for (let i = 0, len = token.length; i < len; i++) {
            if (token.charCodeAt(i) === 46) count++;
        }
        return count;
    }

    /**
     * Generate the websocket stream URL for a conversation.
     *
     * @param conversationId Conversation id
     * @param token Token to include as t= query param
     * @param watermark Optional watermark query param (default '-')
     * @returns Fully formed stream URL string
     */
    private generateStreamUrl(conversationId: string, token: string, watermark: string = '-'): string {
        return `${this.socketUrl}/v3/directline/conversations/${conversationId}/stream?watermark=${watermark}&t=${token}`;
    }
}
