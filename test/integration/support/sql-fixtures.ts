import { type SQL } from 'bun';

/**
 * Raw SQL builders for schema tests. They deliberately bypass the domain and the ORM: the point
 * is to prove the database itself rejects invalid data.
 */

export type Row = Record<string, unknown>;
export const HASH = 'a'.repeat(64);

export async function insertRow(sql: SQL, table: string, row: Row): Promise<void> {
  const columns = Object.keys(row);
  const placeholders = columns.map((_, index) => `$${String(index + 1)}`);
  await sql.unsafe(
    `insert into ${table} (${columns.join(', ')}) values (${placeholders.join(', ')})`,
    Object.values(row),
  );
}

export function walletRow(overrides: Row = {}): Row {
  return {
    id: crypto.randomUUID(),
    player_id: crypto.randomUUID(),
    currency: 'BRL',
    balance: '0.00',
    version: 1,
    created_at: new Date(),
    updated_at: new Date(),
    ...overrides,
  };
}

export function transactionRow(walletId: string, playerId: string, overrides: Row = {}): Row {
  const externalId = `ext-${crypto.randomUUID()}`;
  return {
    id: crypto.randomUUID(),
    provider_id: 'provider-a',
    external_transaction_id: externalId,
    idempotency_key: `provider-a:${externalId}`,
    payload_hash: HASH,
    wallet_id: walletId,
    player_id: playerId,
    round_id: 'round-1',
    game_id: 'fortune-chimp',
    kind: 'BET',
    amount: '25.00',
    currency: 'BRL',
    reference_external_transaction_id: null,
    reference_transaction_id: null,
    status: 'PROCESSED',
    failure_code: null,
    observed_balance: '75.00',
    attempts: 0,
    next_attempt_at: null,
    created_at: new Date(),
    processed_at: new Date(),
    ...overrides,
  };
}

export function ledgerRow(overrides: Row & { wallet_id: string; transaction_id: string }): Row {
  return {
    id: crypto.randomUUID(),
    currency: 'BRL',
    direction: 'DEBIT',
    amount: '25.00',
    balance_before: '100.00',
    balance_after: '75.00',
    wallet_version: 2,
    created_at: new Date(),
    ...overrides,
  };
}

export interface SeededWallet {
  walletId: string;
  playerId: string;
  openingTransactionId: string | undefined;
}

/** Inserts a valid wallet; a positive balance comes with its OPENING transaction and entry. */
export async function seedWallet(
  sql: SQL,
  balance = '100.00',
  currency = 'BRL',
): Promise<SeededWallet> {
  const wallet = walletRow({ balance, currency });
  const walletId = wallet.id as string;
  const playerId = wallet.player_id as string;

  if (balance === '0.00') {
    await insertRow(sql, 'wallets', wallet);
    return { walletId, playerId, openingTransactionId: undefined };
  }

  const opening = transactionRow(walletId, playerId, {
    provider_id: 'internal',
    external_transaction_id: `opening:${walletId}`,
    idempotency_key: `opening:${walletId}`,
    round_id: 'opening',
    game_id: 'internal',
    kind: 'OPENING',
    amount: balance,
    currency,
    observed_balance: balance,
  });
  await sql.begin(async (tx) => {
    await insertRow(tx, 'wallets', wallet);
    await insertRow(tx, 'wager_transactions', opening);
    await insertRow(
      tx,
      'wallet_ledger_entries',
      ledgerRow({
        wallet_id: walletId,
        transaction_id: opening.id as string,
        currency,
        direction: 'CREDIT',
        amount: balance,
        balance_before: '0.00',
        balance_after: balance,
        wallet_version: 1,
      }),
    );
  });
  return { walletId, playerId, openingTransactionId: opening.id as string };
}

/**
 * Applies a valid BET debit exactly as the application must: transaction, wallet update with
 * version + 1 and the matching ledger entry, in one SQL transaction.
 */
export async function applyDebit(
  sql: SQL,
  wallet: SeededWallet,
  movement: { amount: string; balanceBefore: string; balanceAfter: string; newVersion: number },
  transactionOverrides: Row = {},
): Promise<string> {
  const bet = transactionRow(wallet.walletId, wallet.playerId, {
    amount: movement.amount,
    observed_balance: movement.balanceAfter,
    ...transactionOverrides,
  });
  await sql.begin(async (tx) => {
    await insertRow(tx, 'wager_transactions', bet);
    await tx.unsafe(
      'update wallets set balance = $1, version = $2, updated_at = now() where id = $3',
      [movement.balanceAfter, movement.newVersion, wallet.walletId],
    );
    await insertRow(
      tx,
      'wallet_ledger_entries',
      ledgerRow({
        wallet_id: wallet.walletId,
        transaction_id: bet.id as string,
        amount: movement.amount,
        balance_before: movement.balanceBefore,
        balance_after: movement.balanceAfter,
        wallet_version: movement.newVersion,
      }),
    );
  });
  return bet.id as string;
}
