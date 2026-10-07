import { Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { OpenBotSecretService } from '../openbotsecret/openbotsecret.service';
import { AccessTokenResponseDto } from 'src/dto/token.dto';
import { ConfigService } from '@nestjs/config';
import * as bcrypt from 'bcrypt';
import { JwtPayload } from 'jsonwebtoken';

const ADMIN_ROLE = 'admin';

@Injectable()
export class AuthorizationService {
    private readonly directLineHost: string;
    private readonly expirationSeconds: number;

    constructor(
        private readonly jwtService: JwtService,
        private readonly openBotSecretService: OpenBotSecretService,
        private readonly configService: ConfigService
    ) {
        this.expirationSeconds = Number(this.configService.get<number | string>('JWT_EXPIRATION_SECONDS')) || 3600;
    }

    /**
     * Generate an access token for the admin user given username and password.
     * Validates credentials against ADMIN_USERNAME and ADMIN_PASSWORD env vars.
     *
     * @param username Provided username
     * @param password Provided password
     * @returns AccessTokenResponseDto containing token_type, expires_in and access_token
     * @throws UnauthorizedException if credentials do not match
     */
    async generateUserToken(username: string, password: string): Promise<AccessTokenResponseDto> {
        const adminUsername = this.configService.get<string>('ADMIN_USERNAME');
        const adminPasswordHash = this.configService.get<string>('ADMIN_PASSWORD');

        if (!adminUsername || !adminPasswordHash || username !== adminUsername) {
            throw new UnauthorizedException('Invalid credentials');
        }

        const isPasswordValid = await bcrypt.compare(password, adminPasswordHash);
        if (!isPasswordValid) {
            throw new UnauthorizedException('Invalid credentials');
        }

        const tokenPayload = { sub: username, role: ADMIN_ROLE };

        const accessToken = this.jwtService.sign(tokenPayload, {
            algorithm: 'HS256',
            expiresIn: this.expirationSeconds
        });

        return {
            token_type: 'Bearer',
            expires_in: this.expirationSeconds,
            access_token: accessToken
        };
    }

    /**
     * Verify an admin token issued by generateUserToken.
     * All token types share JWT_SECRET, so the signature alone does not tell them apart.
     *
     * @param token JWT string to verify
     * @throws UnauthorizedException when the token is invalid or is not an admin token
     */
    verifyAdminToken(token: string): void {
        const payload = this.verifyJwt(token);
        if (payload.role !== ADMIN_ROLE || payload.sub !== this.configService.get<string>('ADMIN_USERNAME')) {
            throw new UnauthorizedException('Not an admin token');
        }
    }

    /**
     * Verify a bot token issued by generateAccessToken (client credentials).
     * The subject must be an existing, unexpired client credential.
     *
     * @param token JWT string to verify
     * @throws UnauthorizedException when the token is invalid or is not a bot token
     */
    async verifyBotToken(token: string): Promise<void> {
        const payload = this.verifyJwt(token);
        if (!payload.sub || payload.role || payload.conv) {
            throw new UnauthorizedException('Not a bot token');
        }
        try {
            await this.openBotSecretService.findValidByIdCached(payload.sub);
        } catch {
            throw new UnauthorizedException('Not a bot token');
        }
    }

    private verifyJwt(token: string): JwtPayload {
        try {
            return this.jwtService.verify<JwtPayload>(token);
        } catch (e: unknown) {
            throw new UnauthorizedException(`Invalid token. ${String(e)}`);
        }
    }

    /**
     * Generate an access token for a client given its id and secret.
     * Validates credentials via OpenBotSecretService.
     *
     * @param clientId Client identifier (open bot secret id)
     * @param clientSecret Client secret plain text
     * @param scope Optional scope/audience to embed in the token
     * @returns AccessTokenResponseDto containing token_type, expires_in and access_token
     * @throws UnauthorizedException if credentials invalid
     */
    async generateAccessToken(clientId: string, clientSecret: string, scope?: string): Promise<AccessTokenResponseDto> {
        await this.openBotSecretService.validateSecretCached(clientId, clientSecret);

        const tokenPayload = {
            aud: scope || 'https://api.botframework.com/.default',
            iss: this.directLineHost,
            sub: clientId
        };

        const accessToken = this.jwtService.sign(tokenPayload, {
            algorithm: 'HS256',
            expiresIn: this.expirationSeconds
        });

        return {
            token_type: 'Bearer',
            expires_in: this.expirationSeconds,
            access_token: accessToken
        };
    }
}
