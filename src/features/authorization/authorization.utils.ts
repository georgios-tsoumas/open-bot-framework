import * as crypto from 'crypto';

export class AuthorizationUtils {
    static generateRandom(length: number) {
        const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz_-~';
        const bytes = crypto.randomBytes(length);
        return Array.from(bytes)
            .map(b => chars[b % chars.length])
            .join('');
    }

    static createHash(payload: string): string {
        return crypto.createHash('sha256').update(payload).digest('hex');
    }

    /**
     * Constant-time string comparison. Hashing first gives equal-length buffers for timingSafeEqual.
     */
    static secretsMatch(provided: string, expected: string): boolean {
        return crypto.timingSafeEqual(
            crypto.createHash('sha256').update(provided).digest(),
            crypto.createHash('sha256').update(expected).digest()
        );
    }

    static createSecret(length: number): string {
        const bytes = crypto.randomBytes(length);
        return bytes.toString('base64url');
    }

    static createWebChatSecret(siteId: string): string {
        return `${siteId}.${this.createSecret(32)}`;
    }

    static removeBearer(authorizationHeader: string): string | undefined {
        if (!authorizationHeader) {
            return undefined;
        }
        return authorizationHeader.split('Bearer ')[1];
    }
}
