/**
 * Interface for an atomic operations manager.
 */
export interface AtomicOperationsManager {
    /**
     * Take the next sequence number for a key. The first call returns 0.
     * @param key - The key to increment.
     * @returns The sequence number taken by this call.
     */
    incr(key: string): Promise<number>;
}
