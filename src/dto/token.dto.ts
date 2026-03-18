import { IsString, IsOptional } from 'class-validator';

export class LoginDto {
    @IsString()
    username: string;

    @IsString()
    password: string;
}

export class AccessTokenRequestDto {
    @IsString()
    grant_type: string;

    @IsString()
    client_id: string;

    @IsString()
    client_secret: string;

    @IsOptional()
    @IsString()
    scope?: string;
}

export interface AccessTokenResponseDto {
    token_type: string;
    expires_in: number;
    access_token: string;
}
