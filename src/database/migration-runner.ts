import { Injectable, Logger } from '@nestjs/common';
import { DataSource, QueryRunner } from 'typeorm';

const LOCK_NAME = 'obf:migrations';
const LOCK_TIMEOUT_MS = 120_000;
const POLL_MS = 1000;

const lockTimeoutError = () => new Error(`Timed out after ${LOCK_TIMEOUT_MS} ms waiting for the migration lock`);
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Runs pending migrations at boot under a DB-wide lock, so replicas starting together never run DDL
 * at the same time. Replaces TypeORM `synchronize`, which let every pod alter the schema and let an
 * old pod undo a newer schema during a rolling deploy.
 *
 * The lock is session-level, so it is taken on a dedicated connection that stays open until release.
 */
@Injectable()
export class MigrationRunner {
    private readonly logger = new Logger(this.constructor.name);

    constructor(private readonly dataSource: DataSource) {}

    async run(): Promise<void> {
        const queryRunner = this.dataSource.createQueryRunner();
        await queryRunner.connect();
        try {
            await this.acquire(queryRunner);
            const applied = await this.dataSource.runMigrations({ transaction: 'each' });
            this.logger.log(`Migrations applied: ${applied.length ? applied.map(m => m.name).join(', ') : 'none'}`);
        } finally {
            await this.release(queryRunner).catch((e: unknown) =>
                this.logger.warn(`Lock release failed: ${String(e)}`)
            );
            await queryRunner.release();
        }
    }

    private async acquire(queryRunner: QueryRunner): Promise<void> {
        const type = this.dataSource.options.type;
        if (type === 'postgres') {
            // pg_advisory_lock would wait forever; poll the try-variant so a stuck holder fails boot instead
            const deadline = Date.now() + LOCK_TIMEOUT_MS;
            for (;;) {
                const rows = (await queryRunner.query('SELECT pg_try_advisory_lock(hashtext($1)) AS locked', [
                    LOCK_NAME
                ])) as { locked: boolean }[];
                if (rows[0]?.locked) {
                    return;
                }
                if (Date.now() >= deadline) {
                    throw lockTimeoutError();
                }
                this.logger.log('Waiting for the migration lock held by another instance');
                await sleep(POLL_MS);
            }
        }
        if (type === 'mysql' || type === 'mariadb') {
            const rows = (await queryRunner.query('SELECT GET_LOCK(?, ?) AS locked', [
                LOCK_NAME,
                LOCK_TIMEOUT_MS / 1000
            ])) as { locked: number | string | null }[];
            if (Number(rows[0]?.locked) !== 1) {
                throw lockTimeoutError();
            }
            return;
        }
        throw new Error(`Unsupported database type for migrations: ${type}`);
    }

    private async release(queryRunner: QueryRunner): Promise<void> {
        const type = this.dataSource.options.type;
        if (type === 'postgres') {
            await queryRunner.query('SELECT pg_advisory_unlock(hashtext($1))', [LOCK_NAME]);
        } else if (type === 'mysql' || type === 'mariadb') {
            await queryRunner.query('SELECT RELEASE_LOCK(?)', [LOCK_NAME]);
        }
    }
}
