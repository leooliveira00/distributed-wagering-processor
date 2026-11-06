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

  it('apply the schema and the integrity triggers', async () => {
    const applied = await db.orm.migrator.up();

    expect(applied.map((migration) => migration.name)).toEqual([
      'Migration20261106000100_initial_schema',
      'Migration20261106000200_ledger_integrity',
    ]);
    expect(await tables()).toEqual(TABLES);
    expect(await triggers()).toEqual([
      'wallet_ledger_entries_match_wallet',
      'wallet_ledger_entries_no_truncate',
      'wallet_ledger_entries_no_update_delete',
      'wallets_balance_has_ledger_entry',
      'wallets_guard_changes',
    ]);
  });

  it('revert one migration at a time', async () => {
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
