import { BadRequestException, Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { Activity, ConversationReference } from 'botframework-schema';
import { DirectLineTokenPayload } from 'src/dto/directline.dto';
import { AuthorizationUtils } from '../authorization/authorization.utils';
import { ConfigService } from '@nestjs/config';
import { AuthorizationService } from '../authorization/authorization.service';
import { ConversationResponse } from 'src/dto/conversation.dto';
import { OpenBotService } from '../openbot/openbot.service';
import { HttpService } from '@nestjs/axios';
import { lastValueFrom } from 'rxjs';
import { ConversationPublisher } from './conversation-publisher.service';
import { isWatermark } from './conversation-stream.types';
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
        private readonly publisher: ConversationPublisher,
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
        if (!convRef?.user?.id) {
            throw new BadRequestException('No user provided');
        }

        // Identify type of security key
        const dots = this.countDots(securityKey);
        // JWT token (need to avoid the costly verify method)
        if (dots === 2) {
            const validPayload = this.directLineTokenService.verifyDirectLineToken(securityKey);
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
            const tokenResponse = await this.directLineTokenService.generateToken(authorizationHeader, convRef.user.id);
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
     * Return conversation metadata with a fresh stream URL. DirectLine clients call this to reconnect;
     * the stream URL carries their watermark so the gateway replays what they missed. It never
     * changes the activity counter: rewinding it would hand out ids that were already used.
     *
     * @param conversationId Conversation identifier
     * @param authorizationHeader Authorization header containing directline token
     * @param watermark Client's last watermark, passed through to the stream URL
     * @returns ConversationResponse with token and stream URL
     * @throws BadRequestException if header missing/invalid
     */
    getConversation(conversationId: string, authorizationHeader: string, watermark: string): ConversationResponse {
        const securityKey = AuthorizationUtils.removeBearer(authorizationHeader);
        if (!securityKey) {
            throw new BadRequestException('Wrong type of token provided. Provide Bearer');
        }
        const validPayload = this.directLineTokenService.verifyDirectLineToken(securityKey);
        if (conversationId !== validPayload.conv) {
            throw new UnauthorizedException('Token does not belong to this conversation');
        }
        return {
            conversationId,
            expires_in: this.expires,
            token: securityKey,
            streamUrl: this.generateStreamUrl(
                conversationId,
                securityKey,
                isWatermark(watermark) ? watermark : undefined
            )
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
        const validPayload = this.verifyConversationToken(conversationId, authorizationHeader);
        this.assertActivity(activity);

        // Set bot recipient
        activity.recipient = { id: `${validPayload.bot}@${validPayload.site}`, name: validPayload.bot };
        const { activity: newActivity, seq } = await this.createActivity(conversationId, activity, files);

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
        } catch (err) {
            throw new BadRequestException(`Failed to post to bot endpoint: ${err}`);
        }
        // Echo to the client only once the bot accepted it. Stored and numbered like bot replies, so
        // a reconnecting client gets its own messages back too.
        this.logger.verbose(`User sends type: ${newActivity.type}, text: ${newActivity.text}`);
        await this.publisher.publish(conversationId, newActivity, seq);
        return { id: newActivity.id };
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
        await this.authorizationService.verifyBotToken(token);
        this.assertActivity(activity);

        if (replyToActivity) {
            activity.replyToId = replyToActivity;
        }

        // Create the activity
        const { activity: newActivity, seq } = await this.createActivity(conversationId, activity);

        this.logger.verbose(`Bot replies with type: ${newActivity.type}, text: ${newActivity.text}`);
        await this.publisher.publish(conversationId, newActivity, seq);
        return { id: newActivity.id };
    }

    /**
     * Internal helper to create an activity object: assign id, timestamp, serviceUrl and conversation.
     * When files are provided they are uploaded and attachments updated prior to id assignment.
     *
     * @param conversationId Conversation id for id generation and object pathing
     * @param activity Activity object to enrich (mutated in place and returned)
     * @param files Optional array of UploadDto to persist and attach
     * @returns Enriched Activity and its ID sequence number (null for typing)
     */
    private async createActivity(
        conversationId: string,
        activity: Activity,
        files?: UploadDto[]
    ): Promise<{ activity: Activity; seq: number | null }> {
        if (files) {
            await this.storageService.uploadToActivity(files, conversationId, activity);
        }

        // Activity identity is independent of publication order. Redis assigns the delivery cursor
        // when the publisher atomically stores and emits the activity.
        let seq: number | null = null;
        if (activity.type !== 'typing') {
            seq = await this.atomicOperationService.incr(conversationId);
            activity.id = `${conversationId}|${String(seq).padStart(7, '0')}`;
        } else {
            activity.id = `${conversationId}|${AuthorizationUtils.generateRandom(11)}`;
        }

        // Timestamp
        activity.timestamp = new Date();

        // Service url
        activity.serviceUrl = this.host;

        // Append Conversation
        activity.conversation = { id: conversationId, isGroup: false, conversationType: '', name: '' };

        return { activity, seq };
    }

    /**
     * Verify a DirectLine token from an Authorization header and check it belongs to the conversation.
     *
     * @throws BadRequestException if the header is missing, UnauthorizedException / ForbiddenException if the token is not valid
     */
    verifyConversationToken(conversationId: string, authorizationHeader: string): DirectLineTokenPayload {
        const token = AuthorizationUtils.removeBearer(authorizationHeader);
        if (!token) {
            throw new BadRequestException('Wrong type of token provided. Provide Bearer');
        }
        const validPayload = this.directLineTokenService.verifyDirectLineToken(token);
        if (conversationId !== validPayload.conv) {
            throw new UnauthorizedException('Token does not belong to this conversation');
        }
        return validPayload;
    }

    private assertActivity(activity: unknown): asserts activity is Activity {
        if (typeof activity !== 'object' || activity === null || Array.isArray(activity)) {
            throw new BadRequestException('Activity must be a JSON object');
        }
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
