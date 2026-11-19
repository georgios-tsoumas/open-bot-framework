import { Activity } from 'botframework-schema';
import Redis from 'ioredis';
import { ActivityStoreService } from './activity-store.service';
import { ConversationPublisher } from './conversation-publisher.service';

describe('ConversationPublisher', () => {
    const redis = { publish: jest.fn().mockResolvedValue(1) };
    const store = { saveAndPublish: jest.fn().mockResolvedValue(undefined) };
    const publisher = new ConversationPublisher(redis as unknown as Redis, store as unknown as ActivityStoreService);

    beforeEach(() => jest.clearAllMocks());

    it('stores and publishes a numbered activity atomically', async () => {
        const activity = { id: 'conv1|0000002', type: 'message' } as Activity;
        await publisher.publish('conv1', activity, 2);
        expect(store.saveAndPublish).toHaveBeenCalledWith('conv1', 2, activity);
        expect(redis.publish).not.toHaveBeenCalled();
    });

    it('publishes typing without storing it', async () => {
        const activity = { type: 'typing' } as Activity;
        await publisher.publish('conv1', activity, null);
        expect(store.saveAndPublish).not.toHaveBeenCalled();
        expect(redis.publish).toHaveBeenCalledWith('obf:conv:conv1', JSON.stringify({ seq: null, activity }));
    });

    it('does not publish when storing fails', async () => {
        store.saveAndPublish.mockRejectedValueOnce(new Error('redis down'));
        await expect(publisher.publish('conv1', {} as Activity, 1)).rejects.toThrow('redis down');
        expect(redis.publish).not.toHaveBeenCalled();
    });
});
