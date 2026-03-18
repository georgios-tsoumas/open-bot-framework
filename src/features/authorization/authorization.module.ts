import { Global, Module } from '@nestjs/common';
import { AuthorizationService } from './authorization.service';
import { AuthorizationController } from './authorization.controller';
import { OpenBotsecretModule } from '../openbotsecret/openbotsecret.module';
import { OpenBotSecretService } from '../openbotsecret/openbotsecret.service';

@Global()
@Module({
    imports: [OpenBotsecretModule],
    providers: [AuthorizationService, OpenBotSecretService],
    controllers: [AuthorizationController],
    exports: [AuthorizationService]
})
export class AuthorizationModule {}
