/*
https://docs.nestjs.com/providers#services
*/

import { HttpException, HttpStatus, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Client as MinioClient } from 'minio';
import { Activity } from 'botframework-schema';
import * as crypto from 'crypto';
import { UploadDto } from 'src/dto/upload.dto';

@Injectable()
export class StorageService {
    private storageBucket: string;
    private storageEndpoint: string;
    private storageHandle: MinioClient;

    constructor(private configService: ConfigService) {
        this.storageBucket = this.configService.get('STORAGE_BUCKET') || '';
        this.storageEndpoint = this.configService.get('STORAGE_ENDPOINT') || '';
        try {
            // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- see getStorageHandle
            this.storageHandle = this.getStorageHandle();
        } catch (_: unknown) {
            console.log(_);
        }
    }

    /**
     * Upload an array of incoming files and attach resulting URLs to the provided activity attachments.
     *
     * @param files Array of UploadDto containing filename, buffer, mimetype etc.
     * @param conversationId Conversation id used to generate object keys
     * @param activity Activity object whose attachments will be updated with contentUrl
     * @throws HttpException when any individual upload fails
     */
    async uploadToActivity(files: UploadDto[], conversationId: string, activity: Activity) {
        for (const file of files) {
            try {
                await this.save(file, conversationId, response => {
                    const attachment = activity.attachments?.find(a => a.name === response.filename);
                    if (attachment) {
                        attachment.contentUrl = response.location;
                    }
                });
            } catch (e: unknown) {
                throw new HttpException(
                    `Could not upload an incoming file: ${file.filename}: ${String(e)}`,
                    HttpStatus.INTERNAL_SERVER_ERROR
                );
            }
        }
    }

    /**
     * Save a single file buffer to configured S3-compatible storage using AWS SDK v3 (lib-storage).
     * Calls the provided callback with the resulting location and original filename on success.
     *
     * @param file UploadDto containing filename, buffer and mimetype
     * @param conversationId Conversation identifier to include in object key path
     * @param callback Function invoked with { location, filename } after successful upload
     * @returns Promise<void> resolves when upload completes or rejects on failure
     */
    async save(
        file: UploadDto,
        conversationId: string,
        callback: (response: { location: string; filename: string }) => void
    ): Promise<void> {
        const { filename, buffer, mimetype } = file;
        const key = this.generateObjectKey(filename, conversationId);

        // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call -- see getStorageHandle
        await this.storageHandle.putObject(this.storageBucket, key, buffer, buffer.length, {
            'Content-Type': mimetype
        });

        const location = `${this.storageEndpoint}/${this.storageBucket}/${key}`;
        callback({ location, filename });
    }

    /**
     * Generate an object key for storage using conversation id, sanitized filename and a random suffix.
     * Ensures filename uniqueness and avoids spaces.
     *
     * @param filename Original file name (may be empty)
     * @param conversationId Conversation id to prefix the key
     * @returns string object key to use for storage (e.g. "<conv>/attachments/<name>-<id>.<ext>")
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

    /**
     * Create and return an S3Client configured from env vars.
     * Uses endpoint, credentials and region from configuration.
     *
     * @returns S3Client instance configured for the target storage backend
     */
    private getStorageHandle(): MinioClient {
        const url = new URL(this.storageEndpoint);
        // eslint-disable-next-line @typescript-eslint/no-unsafe-call -- minio v8 uses .js extension imports in its .d.ts files, which moduleResolution:node cannot resolve
        return new MinioClient({
            endPoint: url.hostname,
            port: url.port ? parseInt(url.port) : undefined,
            useSSL: url.protocol === 'https:',
            accessKey: String(this.configService.get('STORAGE_ACCESS_KEY') || ''),
            secretKey: String(this.configService.get('STORAGE_SECRET_KEY') || '')
        });
    }
}
