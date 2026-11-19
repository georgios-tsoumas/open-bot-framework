import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/**
 * Open WebSockets held by this pod against the soft cap MAX_WS_CONNECTIONS, for the load balancer
 * probe. Unset cap means no limit. Lives in HealthModule, like DrainStateService, so the gateway can
 * report its count without a circular import.
 */
@Injectable()
export class SocketLoadService {
    readonly maxSockets: number | null;
    private sockets = 0;

    /** Reads MAX_WS_CONNECTIONS and fails startup when it is set but not a positive integer. */
    constructor(configService: ConfigService) {
        const max = configService.get<string>('MAX_WS_CONNECTIONS');
        if (!max) {
            this.maxSockets = null;
            return;
        }
        const parsed = Number(max);
        if (!Number.isInteger(parsed) || parsed < 1) {
            throw new Error(`MAX_WS_CONNECTIONS must be a positive integer, got '${max}'`);
        }
        this.maxSockets = parsed;
    }

    /** Records how many sockets the gateway currently holds. */
    update(count: number): void {
        this.sockets = count;
    }

    /** Sockets currently held by this pod. */
    count(): number {
        return this.sockets;
    }

    /** True once the open socket count reaches the cap. Never true without a cap. */
    isFull(): boolean {
        return this.maxSockets !== null && this.sockets >= this.maxSockets;
    }
}
