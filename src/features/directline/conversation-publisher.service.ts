import { Inject, Injectable } from '@nestjs/common';
import { Activity } from 'botframework-schema';
import Redis from 'ioredis';
import { REDIS_CLIENT } from '../redis/redis.constants';
import { ActivityStoreService } from './activity-store.service';
import { ConversationMessage, conversationChannel } from './conversation-stream.types';

/**
 * Sends an activity to whichever replica holds the conversation's websocket. The activity is stored
 * before it is published, so a client that is not connected right now gets it on reconnect.
 */
@Injectable()
export class ConversationPublisher {
    constructor(
        @Inject(REDIS_CLIENT) private readonly redis: Redis,
        private readonly activityStore: ActivityStoreService
    ) {}

    /** @param seq - the activity's sequence number, or null for typing (not stored). */
    async publish(conversationId: string, activity: Activity, seq: number | null): Promise<void> {
        if (seq !== null) {
            await this.activityStore.save(conversationId, seq, activity);
        }
        const message: ConversationMessage = { seq, activity };
        await this.redis.publish(conversationChannel(conversationId), JSON.stringify(message));
    }
}
