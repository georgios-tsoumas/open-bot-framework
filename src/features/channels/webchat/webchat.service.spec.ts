import { createCache } from 'cache-manager';
import { Repository } from 'typeorm';
import { WebChatChannel } from 'src/entities/webchat.entity';
import { OpenBotService } from '../../openbot/openbot.service';
import { WebChatService } from './webchat.service';

describe('WebChatService.findByIdCached', () => {
    const findOne = jest.fn();
    const repository = { findOne } as unknown as Repository<WebChatChannel>;
    const cache = createCache();
    const service = new WebChatService({} as OpenBotService, repository, cache);

    beforeEach(async () => {
        findOne.mockReset();
        await cache.clear();
    });

    it('caches a channel that exists', async () => {
        findOne.mockResolvedValue({ id: 'site1' });
        await service.findByIdCached('site1');
        await service.findByIdCached('site1');
        expect(findOne).toHaveBeenCalledTimes(1);
    });

    it('does not cache a made-up id', async () => {
        findOne.mockResolvedValue(null);
        await service.findByIdCached('made-up');
        expect(await cache.get('webchat:made-up:')).toBeUndefined();
    });
});
