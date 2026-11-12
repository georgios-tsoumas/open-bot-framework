import { DataSource } from 'typeorm';
import { MigrationRunner } from './migration-runner';

describe('MigrationRunner', () => {
    const setup = (type: string, lockResults: unknown[][]) => {
        const query = jest.fn((sql: string) => {
            if (/pg_try_advisory_lock|GET_LOCK/.test(sql)) {
                return Promise.resolve(lockResults.shift() ?? []);
            }
            return Promise.resolve([]);
        });
        const queryRunner = { connect: jest.fn(), release: jest.fn(), query };
        const dataSource = {
            options: { type },
            createQueryRunner: () => queryRunner,
            runMigrations: jest.fn().mockResolvedValue([{ name: 'Baseline1794441600000' }])
        };
        return { runner: new MigrationRunner(dataSource as unknown as DataSource), dataSource, queryRunner, query };
    };

    afterEach(() => jest.useRealTimers());

    it('postgres: takes the advisory lock, migrates, unlocks', async () => {
        const { runner, dataSource, query, queryRunner } = setup('postgres', [[{ locked: true }]]);
        await runner.run();
        expect(query).toHaveBeenNthCalledWith(1, expect.stringContaining('pg_try_advisory_lock'), ['obf:migrations']);
        expect(dataSource.runMigrations).toHaveBeenCalledWith({ transaction: 'each' });
        expect(query).toHaveBeenLastCalledWith(expect.stringContaining('pg_advisory_unlock'), ['obf:migrations']);
        expect(queryRunner.release).toHaveBeenCalled();
    });

    it('postgres: waits while another instance holds the lock', async () => {
        jest.useFakeTimers();
        const { runner, dataSource } = setup('postgres', [[{ locked: false }], [{ locked: true }]]);
        const running = runner.run();
        await jest.advanceTimersByTimeAsync(1000);
        await running;
        expect(dataSource.runMigrations).toHaveBeenCalledTimes(1);
    });

    it('postgres: gives up after 120s without the lock', async () => {
        jest.useFakeTimers();
        const { runner, dataSource, queryRunner } = setup(
            'postgres',
            Array.from({ length: 200 }, () => [{ locked: false }])
        );
        const running = runner.run();
        const assertion = expect(running).rejects.toThrow('Timed out');
        await jest.advanceTimersByTimeAsync(121_000);
        await assertion;
        expect(dataSource.runMigrations).not.toHaveBeenCalled();
        expect(queryRunner.release).toHaveBeenCalled();
    });

    it('mysql: uses GET_LOCK with a 120s timeout and releases it', async () => {
        const { runner, query } = setup('mysql', [[{ locked: 1 }]]);
        await runner.run();
        expect(query).toHaveBeenNthCalledWith(1, expect.stringContaining('GET_LOCK'), ['obf:migrations', 120]);
        expect(query).toHaveBeenLastCalledWith(expect.stringContaining('RELEASE_LOCK'), ['obf:migrations']);
    });

    it('mysql: fails when GET_LOCK times out', async () => {
        const { runner, dataSource } = setup('mysql', [[{ locked: 0 }]]);
        await expect(runner.run()).rejects.toThrow('Timed out');
        expect(dataSource.runMigrations).not.toHaveBeenCalled();
    });

    it('releases the lock when a migration fails', async () => {
        const { runner, dataSource, query } = setup('postgres', [[{ locked: true }]]);
        dataSource.runMigrations.mockRejectedValueOnce(new Error('bad migration'));
        await expect(runner.run()).rejects.toThrow('bad migration');
        expect(query).toHaveBeenLastCalledWith(expect.stringContaining('pg_advisory_unlock'), ['obf:migrations']);
    });

    it('refuses an unsupported database', async () => {
        const { runner } = setup('sqlite', []);
        await expect(runner.run()).rejects.toThrow('Unsupported database type');
    });
});
