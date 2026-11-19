import { Injectable } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { DrainStateService } from './drain-state.service';
import { HealthController } from './health.controller';
import { HealthModule } from './health.module';

describe('HealthController', () => {
    it('returns ok', () => {
        expect(new HealthController().check()).toEqual({ status: 'ok' });
    });
});

describe('HealthModule', () => {
    /** Stands in for DirectLineGateway, which gets the drain flag by importing HealthModule. */
    @Injectable()
    class DrainStateConsumer {
        constructor(readonly drainState: DrainStateService) {}
    }

    it('exports DrainStateService to modules that import it', async () => {
        const moduleRef = await Test.createTestingModule({
            imports: [HealthModule],
            providers: [DrainStateConsumer]
        }).compile();

        expect(moduleRef.get(DrainStateConsumer).drainState).toBeInstanceOf(DrainStateService);
    });
});
