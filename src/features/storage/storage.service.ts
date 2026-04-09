import { HttpException, HttpStatus, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Client as MinioClient } from 'minio';
import { Activity } from 'botframework-schema';
import * as crypto from 'crypto';
import { UploadDto } from 'src/dto/upload.dto';

@Injectable()
export class StorageService {
    private readonly bucket: string;
    private readonly endpoint: string;
    private readonly client: MinioClient;

    constructor(private readonly configService: ConfigService) {
        this.endpoint = this.configService.get<string>('STORAGE_ENDPOINT') ?? '';
        this.bucket = this.configService.get<string>('STORAGE_BUCKET') ?? '';

        if (!this.endpoint) {
            throw new Error('STORAGE_ENDPOINT is required');
        }
        if (!this.bucket) {
            throw new Error('STORAGE_BUCKET is required');
        }

        const url = new URL(this.endpoint);
        this.client = new MinioClient({
            endPoint: url.hostname,
            port: url.port ? parseInt(url.port) : undefined,
            useSSL: url.protocol === 'https:',
            accessKey: this.configService.get<string>('STORAGE_ACCESS_KEY') ?? '',
            secretKey: this.configService.get<string>('STORAGE_SECRET_KEY') ?? ''
        });
    }

    /**
     * Upload an array of incoming files and attach resulting URLs to the provided activity attachments.
     *
     * @param files Array of UploadDto containing filename, buffer, mimetype etc.
     * @param conversationId Conversation id used to generate object keys
     * @param activity Activity object whose attachments will be updated with contentUrl
     * @throws HttpException when any individual upload fails
     */
    async uploadToActivity(files: UploadDto[], conversationId: string, activity: Activity): Promise<void> {
        for (const file of files) {
            try {
                const { location, filename } = await this.save(file, conversationId);
                const attachment = activity.attachments?.find(a => a.name === filename);
                if (attachment) {
                    attachment.contentUrl = location;
                }
            } catch (e: unknown) {
                throw new HttpException(
                    `Could not upload an incoming file: ${file.filename}: ${String(e)}`,
                    HttpStatus.INTERNAL_SERVER_ERROR
                );
            }
        }
    }

    /**
     * Save a single file buffer to configured S3-compatible storage using MinIO client.
     *
     * @param file UploadDto containing filename, buffer and mimetype
     * @param conversationId Conversation identifier to include in object key path
     * @returns Promise resolving to { location, filename } after successful upload
     */
    async save(file: UploadDto, conversationId: string): Promise<{ location: string; filename: string }> {
        const { filename, buffer, mimetype } = file;
        const key = this.generateObjectKey(filename, conversationId);

        await this.client.putObject(this.bucket, key, buffer, buffer.length, {
            'Content-Type': mimetype
        });

        const location = `${this.endpoint}/${this.bucket}/${key}`;
        return { location, filename };
    }

    /**
     * Generate an object key for storage using conversation id, sanitized filename and a random suffix.
     * Format: `{conversationId}/attachments/{name}-{random_id}.{ext}`
     */
    private generateObjectKey(filename: string, conversationId: string): string {
        const id = crypto.randomBytes(8).toString('hex');
        if (filename === '') {
            filename = id;
        } else {
            filename = filename.replaceAll(' ', '_');
            const splitFilename = filename.split(/\.([^.]*)$/);
            filename = `${splitFilename[0]}-${id}`;
            filename += splitFilename[1] ? `.${splitFilename[1]}` : '';
        }
        return `${conversationId}/attachments/${filename}`;
    }
}
