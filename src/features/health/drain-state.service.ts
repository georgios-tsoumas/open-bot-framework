import { Injectable } from '@nestjs/common';

/**
 * Set once the process starts shutting down. Readiness turns 503 so k8s stops routing to this pod,
 * and the gateway refuses new websocket upgrades.
 */
@Injectable()
export class DrainStateService {
    private draining = false;

    start(): void {
        this.draining = true;
    }

    isDraining(): boolean {
        return this.draining;
    }
}
