import { Inject, Injectable } from '@nestjs/common';
import { AtomicOperationsManager } from './atomicity-operations-manager.interface';

@Injectable()
export class AtomicOperationsService {
    constructor(
        @Inject('ATOMIC_OPERATIONS_PROVIDER') private readonly atomicOperationManager: AtomicOperationsManager
    ) {}

    /**
     * Take the next sequence number for a key via the underlying manager.
     * @param key - The key to increment.
     * @returns The sequence number taken by this call (first is 0).
     */
    async incr(key: string): Promise<number> {
        return this.atomicOperationManager.incr(key);
    }
}
