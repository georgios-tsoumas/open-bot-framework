import { Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { OpenBotSecretService } from '../openbotsecret/openbotsecret.service';
import { AccessTokenResponseDto } from 'src/dto/token.dto';
import { ConfigService } from '@nestjs/config';

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
    generateUserToken(username: string, password: string): AccessTokenResponseDto {
        const adminUsername = this.configService.get<string>('ADMIN_USERNAME');
        const adminPassword = this.configService.get<string>('ADMIN_PASSWORD');

        if (!adminUsername || !adminPassword || username !== adminUsername || password !== adminPassword) {
            throw new UnauthorizedException('Invalid credentials');
        }

        const tokenPayload = { sub: username };

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
     * Verify an access token (server-to-server) and return decoded payload.
     *
     * @param token JWT string to verify
     * @returns AccessTokenResponseDto decoded token payload
     * @throws UnauthorizedException when verification fails
     */
    verifyAccessToken(token: string): AccessTokenResponseDto {
        try {
            return this.jwtService.verify<AccessTokenResponseDto>(token);
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
