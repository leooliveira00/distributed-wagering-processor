import { type SQL } from 'bun';
import { expect } from 'bun:test';

/**
 * README §13 final invariant: wallet.balance == balance rebuilt from the ledger.
 * Both sides are computed by PostgreSQL with numeric arithmetic and compared as fixed-scale
 * decimal strings, never through JS numbers.
 */
export async function expectLedgerConsistent(sql: SQL, walletId: string): Promise<void> {
  const rows: { stored: string; rebuilt: string }[] = await sql.unsafe(
    `select w.balance::numeric(38, 2)::text as stored,
            coalesce(sum(case e.direction when 'CREDIT' then e.amount else -e.amount end), 0)
              ::numeric(38, 2)::text as rebuilt
       from wallets w
       left join wallet_ledger_entries e on e.wallet_id = w.id
      where w.id = $1
      group by w.id, w.balance`,
    [walletId],
  );
  const row = rows[0];
  if (!row) throw new Error(`wallet ${walletId} not found`);
  expect({ walletId, balance: row.stored }).toEqual({ walletId, balance: row.rebuilt });
}
