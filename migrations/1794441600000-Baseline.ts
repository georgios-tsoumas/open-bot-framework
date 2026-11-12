import { MigrationInterface, QueryRunner, Table, TableColumnOptions } from 'typeorm';

/**
 * Baseline: the schema TypeORM `synchronize` built for the entities as of HAP-645 (OpenBot,
 * OpenBotSecret, WebChatChannel). Frozen on purpose; later schema changes get their own migrations.
 *
 * Works on Postgres (prod) and MySQL (local dev). Every table is created with `ifNotExist`, so on a
 * database that synchronize already built this is a no-op that only records the baseline. Index and
 * foreign key names are left to the naming strategy, which yields the same names synchronize used.
 */
export class Baseline1794441600000 implements MigrationInterface {
    name = 'Baseline1794441600000';

    public async up(queryRunner: QueryRunner): Promise<void> {
        const isMysql = ['mysql', 'mariadb'].includes(queryRunner.connection.options.type);

        const text = (name: string, extra: Partial<TableColumnOptions> = {}): TableColumnOptions =>
            isMysql
                ? { name, type: 'varchar', length: '255', ...extra }
                : { name, type: 'character varying', ...extra };
        const uuidPrimary = (name: string): TableColumnOptions =>
            isMysql
                ? { name, type: 'varchar', length: '36', isPrimary: true, isGenerated: true, generationStrategy: 'uuid' }
                : { name, type: 'uuid', isPrimary: true, isGenerated: true, generationStrategy: 'uuid' };
        const uuidReference = (name: string): TableColumnOptions =>
            isMysql
                ? { name, type: 'varchar', length: '36', isNullable: true }
                : { name, type: 'uuid', isNullable: true };
        const createDate = (name: string): TableColumnOptions =>
            isMysql
                ? { name, type: 'datetime', precision: 6, default: 'CURRENT_TIMESTAMP(6)' }
                : { name, type: 'timestamp', default: 'now()' };
        const updateDate = (name: string): TableColumnOptions =>
            isMysql
                ? {
                      name,
                      type: 'datetime',
                      precision: 6,
                      default: 'CURRENT_TIMESTAMP(6)',
                      onUpdate: 'CURRENT_TIMESTAMP(6)'
                  }
                : { name, type: 'timestamp', default: 'now()' };
        const nullableDate = (name: string): TableColumnOptions =>
            isMysql ? { name, type: 'datetime', isNullable: true } : { name, type: 'timestamp', isNullable: true };
        const openBotReference = {
            columnNames: ['openBotId'],
            referencedTableName: 'open_bot',
            referencedColumnNames: ['id'],
            onDelete: 'CASCADE',
            onUpdate: 'NO ACTION'
        };

        await queryRunner.createTable(
            new Table({
                name: 'open_bot',
                columns: [
                    uuidPrimary('id'),
                    text('handle'),
                    text('endpoint'),
                    text('schemaVersion', { default: "'v1.3'" }),
                    createDate('createdAt'),
                    updateDate('updatedAt')
                ],
                indices: [{ name: 'IDX_OpenBot_handle', columnNames: ['handle'], isUnique: true }]
            }),
            true
        );

        await queryRunner.createTable(
            new Table({
                name: 'open_bot_secret',
                columns: [
                    uuidPrimary('id'),
                    text('description'),
                    createDate('createdAt'),
                    nullableDate('expiresAt'),
                    text('secretHash'),
                    text('plainReducted'),
                    uuidReference('openBotId')
                ],
                foreignKeys: [openBotReference]
            }),
            true
        );

        await queryRunner.createTable(
            new Table({
                name: 'web_chat_channel',
                columns: [
                    text('id', { isPrimary: true }),
                    text('name'),
                    text('secret1'),
                    text('secret2'),
                    createDate('createdAt'),
                    uuidReference('openBotId')
                ],
                indices: [{ columnNames: ['secret1'] }, { columnNames: ['secret2'] }],
                foreignKeys: [openBotReference]
            }),
            true
        );
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.dropTable('web_chat_channel', true);
        await queryRunner.dropTable('open_bot_secret', true);
        await queryRunner.dropTable('open_bot', true);
    }
}
