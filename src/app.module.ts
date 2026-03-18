import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm'; // added import
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { PostgresConnectionOptions } from 'typeorm/driver/postgres/PostgresConnectionOptions';
import { OpenBotModule } from './features/openbot/openbot.module';
import { OpenBotsecretModule } from './features/openbotsecret/openbotsecret.module';
import { WebChatModule } from './features/channels/webchat/webchat.module';
import { DirectlineModule } from './features/directline/directline.module';
import { AuthorizationModule } from './features/authorization/authorization.module';
import { CacheModule } from '@nestjs/cache-manager';
import { JwtModule } from '@nestjs/jwt';

@Module({
    imports: [
        CacheModule.register({ isGlobal: true }),
        ConfigModule.forRoot({
            envFilePath: ['.env.local', '.env'],
            isGlobal: true
        }),
        DirectlineModule,
        JwtModule.registerAsync({
            imports: [ConfigModule],
            useFactory: (configService: ConfigService) => ({
                secret: configService.get('JWT_SECRET')
            }),
            inject: [ConfigService],
            global: true
        }),
        TypeOrmModule.forRootAsync({
            imports: [ConfigModule],
            useFactory: (configService: ConfigService) =>
                ({
                    type: configService.get('TYPEORM_CONNECTION') as 'postgres',
                    host: configService.get('TYPEORM_HOST'),
                    port: Number(configService.get<number>('TYPEORM_PORT')),
                    username: configService.get('TYPEORM_USERNAME'),
                    password: configService.get('TYPEORM_PASSWORD'),
                    database: configService.get('TYPEORM_DATABASE'),
                    entities: [__dirname + '/**/*.entity{.ts,.js}'],
                    migrations: [__dirname + '/../migrations/*.js'],
                    migrationsRun: configService.get('TYPEORM_AUTORUN_MIGRATIONS') === 'true',
                    synchronize: true,
                    autoLoadEntities: true,
                    dropSchema: false
                }) as PostgresConnectionOptions,
            inject: [ConfigService]
        }),
        AuthorizationModule,
        OpenBotModule,
        OpenBotsecretModule,
        WebChatModule
    ],
    controllers: [AppController],
    providers: [AppService]
})
export class AppModule {}
