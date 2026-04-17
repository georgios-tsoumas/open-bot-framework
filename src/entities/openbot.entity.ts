import { OpenBotDto, OpenBotSecretDto } from 'src/dto/openbot.dto';
import {
    Column,
    Entity,
    PrimaryGeneratedColumn,
    CreateDateColumn,
    UpdateDateColumn,
    ManyToOne,
    JoinColumn,
    Index
} from 'typeorm';

@Entity()
export class OpenBot {
    @PrimaryGeneratedColumn('uuid')
    id: string;

    @Index('IDX_OpenBot_handle', { unique: true })
    @Column()
    handle: string;

    @Column()
    endpoint: string;

    @Column({ default: 'v1.3' })
    schemaVersion: string;

    @CreateDateColumn()
    createdAt: Date;

    @UpdateDateColumn()
    updatedAt: Date;

    toDto(): OpenBotDto {
        return {
            id: this.id,
            handle: this.handle,
            endpoint: this.endpoint,
            schemaVersion: this.schemaVersion,
            createdAt: this.createdAt,
            updatedAt: this.updatedAt
        };
    }
}

@Entity()
export class OpenBotSecret {
    @PrimaryGeneratedColumn('uuid')
    id: string;

    @ManyToOne(() => OpenBot, { onDelete: 'CASCADE' })
    @JoinColumn()
    openBot: OpenBot;

    @Column()
    description: string;

    @CreateDateColumn()
    createdAt: Date;

    @Column({ nullable: true })
    expiresAt: Date;

    @Column()
    secretHash: string;

    @Column()
    plainReducted: string;

    toDto(secret?: string): OpenBotSecretDto {
        return {
            secretId: this.id,
            description: this.description,
            createdAt: this.createdAt,
            expiresAt: this.expiresAt,
            secret: secret ?? this.plainReducted
        };
    }
}
