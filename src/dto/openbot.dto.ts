import { IsString, IsNotEmpty, ValidateBy } from 'class-validator';

export class OpenBotDto {
    id?: string;
    @ValidateBy({
        name: 'IsBotHandle',
        validator: {
            validate: v => typeof v === 'string' && /^[a-zA-Z][a-zA-Z0-9-_]{2,62}[a-zA-Z0-9]$/.test(v),
            defaultMessage: () => 'Invalid bot handle format'
        }
    })
    handle: string;
    @IsString()
    @IsNotEmpty()
    endpoint: string;
    schemaVersion: string;
    createdAt?: Date;
    updatedAt?: Date;
}

export class OpenBotSecretDto {
    secretId?: string;
    @IsString()
    @IsNotEmpty()
    description: string;
    createdAt?: Date;
    expiresAt?: Date;
    secret?: string;
}
