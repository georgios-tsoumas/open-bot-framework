import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { AuthorizationService } from 'src/features/authorization/authorization.service';
import { AuthorizationUtils } from 'src/features/authorization/authorization.utils';

@Injectable()
export class JwtAuthGuard implements CanActivate {
    constructor(private readonly authorizationService: AuthorizationService) {}

    canActivate(context: ExecutionContext): boolean {
        const request = context.switchToHttp().getRequest<{ headers: Record<string, string> }>();
        const token = AuthorizationUtils.removeBearer(request.headers['authorization']);

        if (!token) {
            throw new UnauthorizedException('Missing authorization token');
        }

        this.authorizationService.verifyAccessToken(token);
        return true;
    }
}
