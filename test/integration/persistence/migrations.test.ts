import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { createTestDatabase, type TestDatabase } from '../support/test-database';

const TABLES = [
  'inbox_messages',
  'outbox_messages',
  'wager_transactions',
  'wallet_ledger_entries',
  'wallets',
];

let db: TestDatabase;

async function tables(): Promise<string[]> {
  const rows: { table_name: string }[] = await db.sql.unsafe(
    `select table_name from information_schema.tables
      where table_schema = 'public' and table_name <> 'mikro_orm_migrations'
      order by table_name`,
  );
  return rows.map((row) => row.table_name);
}

async function triggers(): Promise<string[]> {
  const rows: { tgname: string }[] = await db.sql.unsafe(
    `select tgname from pg_trigger where not tgisinternal order by tgname`,
  );
  return rows.map((row) => row.tgname);
}

async function indexExists(name: string): Promise<boolean> {
  const rows: { exists: boolean }[] = await db.sql.unsafe(
    `select exists (select 1 from pg_indexes where schemaname = 'public' and indexname = $1)`,
    [name],
  );
  return rows[0]?.exists ?? false;
}

async function columnExists(table: string, column: string): Promise<boolean> {
  const rows: { exists: boolean }[] = await db.sql.unsafe(
    `select exists (select 1 from information_schema.columns
                     where table_schema = 'public' and table_name = $1 and column_name = $2)`,
    [table, column],
  );
  return rows[0]?.exists ?? false;
}

const DEPENDENTS_INDEX = 'wager_transactions_pending_dependents_idx';

beforeAll(async () => {
  db = await createTestDatabase('migrations', { migrate: false });
});

afterAll(async () => {
  await db.close();
});

describe('migrations', () => {
  it('start with no migration executed', async () => {
    expect(await db.orm.migrator.getExecuted()).toHaveLength(0);
    expect(await tables()).toEqual([]);
  });

  it('apply the schema, the integrity triggers and the indexes', async () => {
    const applied = await db.orm.migrator.up();

    expect(applied.map((migration) => migration.name)).toEqual([
      'Migration20261106000100_initial_schema',
      'Migration20261106000200_ledger_integrity',
      'Migration20261106000300_pending_dependents_index',
      'Migration20261107000400_pending_processing_failures',
      'Migration20261107000500_transaction_integrity',
      'Migration20261107000600_processed_has_entry',
      'Migration20261107000700_reference_and_wallet_integrity',
    ]);
    expect(await columnExists('wager_transactions', 'processing_failures')).toBe(true);
    expect(await tables()).toEqual(TABLES);
    expect(await triggers()).toEqual([
      'wager_transactions_guard_changes',
      'wager_transactions_processed_has_entry',
      'wager_transactions_reference_coherence',
      'wallet_ledger_entries_match_transaction',
      'wallet_ledger_entries_match_wallet',
      'wallet_ledger_entries_no_truncate',
      'wallet_ledger_entries_no_update_delete',
      'wallets_balance_has_ledger_entry',
      'wallets_guard_changes',
      'wallets_initial_version',
    ]);
    expect(await indexExists(DEPENDENTS_INDEX)).toBe(true);
  });

  it('revert one migration at a time', async () => {
    await db.orm.migrator.down();
    expect(await triggers()).toHaveLength(8); // reference and initial version triggers gone

    await db.orm.migrator.down();
    expect(await triggers()).toHaveLength(7); // the processed-has-entry trigger gone

    await db.orm.migrator.down();
    expect(await triggers()).toHaveLength(5); // transaction integrity triggers gone

    await db.orm.migrator.down();
    expect(await columnExists('wager_transactions', 'processing_failures')).toBe(false);
    expect(await indexExists(DEPENDENTS_INDEX)).toBe(true);

    await db.orm.migrator.down();
    expect(await indexExists(DEPENDENTS_INDEX)).toBe(false);
    expect(await triggers()).toHaveLength(5);

    await db.orm.migrator.down();
    expect(await triggers()).toEqual([]);
    expect(await tables()).toEqual(TABLES);

    await db.orm.migrator.down();
    expect(await tables()).toEqual([]);
    expect(await db.orm.migrator.getExecuted()).toHaveLength(0);
  });

  it('reapply cleanly after a full rollback (up -> down -> up)', async () => {
    await db.orm.migrator.up();

    expect(await tables()).toEqual(TABLES);
    expect(await db.orm.migrator.getPending()).toHaveLength(0);
  });
});
