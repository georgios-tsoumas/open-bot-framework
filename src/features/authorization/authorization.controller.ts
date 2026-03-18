import { Body, Controller, HttpException, HttpStatus, Post, UsePipes, ValidationPipe } from '@nestjs/common';
import { AuthorizationService } from './authorization.service';
import { AccessTokenRequestDto, LoginDto } from 'src/dto/token.dto';

@Controller()
@UsePipes(new ValidationPipe())
export class AuthorizationController {
    constructor(private readonly authorizationService: AuthorizationService) {}

    @Post('oauth2/v2.0/token')
    exchangeToken(@Body() body: AccessTokenRequestDto) {
        const { grant_type, client_id, client_secret, scope } = body;

        // Validate required fields
        if (grant_type !== 'client_credentials') {
            throw new HttpException('unsupported_grant_type', HttpStatus.BAD_REQUEST);
        }

        if (!client_id || !client_secret) {
            throw new HttpException('invalid_client', HttpStatus.BAD_REQUEST);
        }

        // Delegate to service
        return this.authorizationService.generateAccessToken(client_id, client_secret, scope);
    }

    @Post('login')
    login(@Body() body: LoginDto) {
        return this.authorizationService.generateUserToken(body.username, body.password);
    }
}
