import { BadRequestException, ForbiddenException, Injectable, UnauthorizedException } from '@nestjs/common';
import { DirectLineTokenPayload, DirectLineTokenResponse } from 'src/dto/directline.dto';
import { AuthorizationUtils } from '../authorization/authorization.utils';
import { WebChatService } from '../channels/webchat/webchat.service';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { TokenExpiredError } from 'jsonwebtoken';

@Injectable()
export class DirectlineTokenService {
    private readonly expires: number;
    private readonly region: string;
    private readonly directLineHost: string;

    constructor(
        private readonly webChatService: WebChatService,
        private readonly configService: ConfigService,
        private readonly jwtService: JwtService
    ) {
        this.expires = Number(this.configService.get<number | string>('JWT_EXPIRATION_SECONDS')) || 3600;
        this.region = String(this.configService.get<string>('DIRECTLINE_REGION') ?? '') || '';
        this.directLineHost = String(this.configService.get<string>('DIRECTLINE_HOST') ?? '') || '';
    }

    /**
     * Create a signed JWT for DirectLine usage given the token payload and expiration.
     *
     * @param payload DirectLineTokenPayload containing bot, site, conv and user
     * @param expiration Expiration in seconds
     * @returns Signed JWT string
     */
    createToken(payload: DirectLineTokenPayload, expiration: number): string {
        const now = Math.floor(Date.now() / 1000);
        const claims = {
            ...payload,
            iss: `https://${this.directLineHost}/`,
            aud: `https://${this.directLineHost}/`,
            nbf: now,
            exp: now + expiration
        };
        return this.jwtService.sign(claims);
    }

    /**
     * Generate a DirectLine token when client provides a site secret.
     * The secret is expected to be in the format "<siteId>.<hmac>" inside a Bearer header.
     *
     * @param authorizationHeader Authorization header value (Bearer secret)
     * @param user Optional user id to embed into token
     * @returns Promise<DirectLineTokenResponse> with conversationId, token and expires_in
     * @throws BadRequestException if header malformed, UnauthorizedException if site not found
     */
    async generateToken(authorizationHeader: string, user?: string): Promise<DirectLineTokenResponse> {
        const secret = AuthorizationUtils.removeBearer(authorizationHeader);
        if (!secret) {
            throw new BadRequestException('Wrong type of secret provided. Provide Bearer');
        }
        // webChatSecret length
        const secretSplit = secret.split('.');
        const siteId = secretSplit[0];
        const hmac = secretSplit[1];
        if (!siteId || !hmac) {
            // TODO: Check alnum for both, and check base64 decode validity for hmac
            throw new BadRequestException('Wrong secret format');
        }
        // Find webchat site
        const webChatSite = await this.webChatService.findByIdCached(siteId, ['openBot']);
        if (
            !webChatSite ||
            !(
                AuthorizationUtils.secretsMatch(secret, webChatSite.secret1) ||
                AuthorizationUtils.secretsMatch(secret, webChatSite.secret2)
            )
        ) {
            throw new UnauthorizedException();
        }
        // Prepare creating the payload
        const conversationId = `${AuthorizationUtils.createSecret(12)}-${this.region}`;
        const tokenPayload = {
            bot: webChatSite.openBot.handle,
            site: siteId,
            conv: conversationId,
            user
        };
        return {
            conversationId,
            expires_in: this.expires,
            token: this.createToken(tokenPayload, this.expires)
        };
    }

    /**
     * Refresh an existing DirectLine token by verifying it and issuing a new signed token.
     *
     * @param authorizationHeader Authorization header containing Bearer <token>
     * @returns Promise<DirectLineTokenResponse>
     * @throws BadRequestException if header invalid, UnauthorizedException if site missing
     */
    async refreshToken(authorizationHeader: string): Promise<DirectLineTokenResponse> {
        const token = AuthorizationUtils.removeBearer(authorizationHeader);
        if (!token) {
            throw new BadRequestException('Wrong type of token provided. Provide Bearer');
        }
        // Validate signature
        const validPayload = this.verifyDirectLineToken(token);

        // Validate site exists
        const webChatSite = await this.webChatService.existsByIdCached(validPayload.site);
        if (!webChatSite) {
            throw new UnauthorizedException();
        }
        // Re-produce token
        const newPayload: DirectLineTokenPayload = {
            bot: validPayload.bot,
            site: validPayload.site,
            conv: validPayload.conv,
            user: validPayload.user
        };

        return {
            conversationId: validPayload.conv,
            expires_in: this.expires,
            token: this.createToken(newPayload, this.expires)
        };
    }

    /**
     * Verify a DirectLine JWT and return its payload.
     *
     * @param token Token string to verify
     * @returns DirectLineTokenPayload parsed from token
     * @throws ForbiddenException when the token has expired (DirectLine clients treat 403 as "get a new token")
     * @throws UnauthorizedException when the token is invalid or is not a DirectLine token
     */
    verifyDirectLineToken(token: string): DirectLineTokenPayload {
        let payload: DirectLineTokenPayload;
        try {
            payload = this.jwtService.verify<DirectLineTokenPayload>(token);
        } catch (e: unknown) {
            if (e instanceof TokenExpiredError) {
                throw new ForbiddenException('Token expired');
            }
            throw new UnauthorizedException(`Invalid token. ${String(e)}`);
        }
        // Admin and bot tokens share JWT_SECRET; only DirectLine tokens carry conv and site
        if (typeof payload.conv !== 'string' || typeof payload.site !== 'string' || payload.role) {
            throw new UnauthorizedException('Not a DirectLine token');
        }
        return payload;
    }
}
