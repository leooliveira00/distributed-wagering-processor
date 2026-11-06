import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import {
  applyDebit,
  HASH,
  insertRow,
  ledgerRow,
  seedWallet,
  transactionRow,
  walletRow,
} from '../support/sql-fixtures';
import {
  createTestDatabase,
  expectPgError,
  SqlState,
  type TestDatabase,
} from '../support/test-database';

/**
 * Every statement here bypasses the domain and the ORM. These tests prove the guarantees of
 * README §5.9 (uniqueness, immutability, non-negativity) live in the schema itself.
 */
let db: TestDatabase;

beforeAll(async () => {
  db = await createTestDatabase('schema_constraints');
});

afterAll(async () => {
  await db.close();
});

const walletState = async (walletId: string) => {
  const rows: { balance: string; version: number }[] = await db.sql.unsafe(
    'select balance, version from wallets where id = $1',
    [walletId],
  );
  return rows[0];
};

describe('valid flows (positive controls)', () => {
  it('accepts a wallet with its opening entry and a later debit', async () => {
    const wallet = await seedWallet(db.sql, '100.00');
    await applyDebit(db.sql, wallet, {
      amount: '25.00',
      balanceBefore: '100.00',
      balanceAfter: '75.00',
      newVersion: 2,
    });

    expect(await walletState(wallet.walletId)).toEqual({ balance: '75.00', version: 2 });
  });

  it('accepts a zero-balance wallet without any ledger entry', async () => {
    const wallet = await seedWallet(db.sql, '0.00');

    expect(await walletState(wallet.walletId)).toEqual({ balance: '0.00', version: 1 });
  });

  it('accepts a rejected transaction in a currency different from the wallet', async () => {
    const wallet = await seedWallet(db.sql, '100.00');

    await insertRow(
      db.sql,
      'wager_transactions',
      transactionRow(wallet.walletId, wallet.playerId, {
        currency: 'USD',
        status: 'REJECTED',
        failure_code: 'CURRENCY_MISMATCH',
        processed_at: null,
        observed_balance: '100.00',
      }),
    );
  });
});

describe('wallets', () => {
  it('rejects a negative balance', async () => {
    await expectPgError(() => insertRow(db.sql, 'wallets', walletRow({ balance: '-0.01' })), {
      sqlState: SqlState.CheckViolation,
      constraint: 'wallets_balance_non_negative_ck',
    });
  });

  it('allows at most one wallet per player and currency', async () => {
    const wallet = await seedWallet(db.sql, '0.00');

    await expectPgError(
      () => insertRow(db.sql, 'wallets', walletRow({ player_id: wallet.playerId })),
      { sqlState: SqlState.UniqueViolation, constraint: 'wallets_player_currency_uq' },
    );
  });

  it('allows the same player in another currency', async () => {
    const wallet = await seedWallet(db.sql, '0.00');

    await insertRow(db.sql, 'wallets', walletRow({ player_id: wallet.playerId, currency: 'USD' }));
  });

  it.each([
    ['lowercase currency', { currency: 'brl' }, 'wallets_currency_format_ck'],
    ['version zero', { version: 0 }, 'wallets_version_positive_ck'],
  ])('rejects %s', async (_, overrides, constraint) => {
    await expectPgError(() => insertRow(db.sql, 'wallets', walletRow(overrides)), {
      sqlState: SqlState.CheckViolation,
      constraint,
    });
  });

  it('rejects a positive opening balance without its ledger entry (at commit)', async () => {
    await expectPgError(() => insertRow(db.sql, 'wallets', walletRow({ balance: '50.00' })), {
      sqlState: SqlState.CheckViolation,
      message: /has no matching ledger entry/,
    });
  });

  it('rejects a balance change without a ledger entry (at commit)', async () => {
    const wallet = await seedWallet(db.sql, '100.00');

    await expectPgError(
      () =>
        db.sql.unsafe('update wallets set balance = 75.00, version = 2 where id = $1', [
          wallet.walletId,
        ]),
      { sqlState: SqlState.CheckViolation, message: /has no matching ledger entry/ },
    );
    expect(await walletState(wallet.walletId)).toEqual({ balance: '100.00', version: 1 });
  });

  it('rejects a ledger entry from an earlier version reused for a new change', async () => {
    // 100 -> 75 (v2), back to 100 (v3), then 100 -> 75 again WITHOUT a new entry must fail,
    // even though an entry 100 -> 75 exists (for v2).
    const wallet = await seedWallet(db.sql, '100.00');
    await applyDebit(db.sql, wallet, {
      amount: '25.00',
      balanceBefore: '100.00',
      balanceAfter: '75.00',
      newVersion: 2,
    });
    const refund = transactionRow(wallet.walletId, wallet.playerId, {
      kind: 'WIN',
      observed_balance: '100.00',
    });
    await db.sql.begin(async (tx) => {
      await insertRow(tx, 'wager_transactions', refund);
      await tx.unsafe('update wallets set balance = 100.00, version = 3 where id = $1', [
        wallet.walletId,
      ]);
      await insertRow(
        tx,
        'wallet_ledger_entries',
        ledgerRow({
          wallet_id: wallet.walletId,
          transaction_id: refund.id as string,
          direction: 'CREDIT',
          balance_before: '75.00',
          balance_after: '100.00',
          wallet_version: 3,
        }),
      );
    });

    await expectPgError(
      () =>
        db.sql.unsafe('update wallets set balance = 75.00, version = 4 where id = $1', [
          wallet.walletId,
        ]),
      { sqlState: SqlState.CheckViolation, message: /has no matching ledger entry/ },
    );
  });

  it('requires the version to move by exactly one when the balance changes', async () => {
    const wallet = await seedWallet(db.sql, '100.00');

    await expectPgError(
      () => db.sql.unsafe('update wallets set balance = 75.00 where id = $1', [wallet.walletId]),
      { sqlState: SqlState.CheckViolation, message: /balance changed but version/ },
    );
    await expectPgError(
      () =>
        db.sql.unsafe('update wallets set balance = 75.00, version = 3 where id = $1', [
          wallet.walletId,
        ]),
      { sqlState: SqlState.CheckViolation, message: /balance changed but version/ },
    );
  });

  it('does not allow the version to change without a balance change', async () => {
    const wallet = await seedWallet(db.sql, '100.00');

    await expectPgError(
      () => db.sql.unsafe('update wallets set version = 2 where id = $1', [wallet.walletId]),
      { sqlState: SqlState.CheckViolation, message: /version changed without a balance change/ },
    );
  });

  it.each([
    ['player_id', 'player_id = gen_random_uuid()'],
    ['currency', "currency = 'USD'"],
  ])('keeps %s immutable', async (_, assignment) => {
    const wallet = await seedWallet(db.sql, '0.00');

    await expectPgError(
      () => db.sql.unsafe(`update wallets set ${assignment} where id = $1`, [wallet.walletId]),
      { sqlState: SqlState.RestrictViolation, message: /identity is immutable/ },
    );
  });

  it('cannot be deleted', async () => {
    const wallet = await seedWallet(db.sql, '0.00');

    await expectPgError(
      () => db.sql.unsafe('delete from wallets where id = $1', [wallet.walletId]),
      { sqlState: SqlState.RestrictViolation, message: /cannot be deleted/ },
    );
  });
});

describe('wager_transactions', () => {
  it('enforces persistent idempotency per provider key', async () => {
    const wallet = await seedWallet(db.sql, '0.00');
    const first = transactionRow(wallet.walletId, wallet.playerId, { idempotency_key: 'k-1' });
    await insertRow(db.sql, 'wager_transactions', first);

    await expectPgError(
      () =>
        insertRow(
          db.sql,
          'wager_transactions',
          transactionRow(wallet.walletId, wallet.playerId, { idempotency_key: 'k-1' }),
        ),
      { sqlState: SqlState.UniqueViolation, constraint: 'wager_transactions_idempotency_uq' },
    );
  });

  it('allows the same idempotency key for a different provider', async () => {
    const wallet = await seedWallet(db.sql, '0.00');
    await insertRow(
      db.sql,
      'wager_transactions',
      transactionRow(wallet.walletId, wallet.playerId, { idempotency_key: 'shared' }),
    );

    await insertRow(
      db.sql,
      'wager_transactions',
      transactionRow(wallet.walletId, wallet.playerId, {
        provider_id: 'provider-b',
        idempotency_key: 'shared',
      }),
    );
  });

  it('stores each provider transaction once', async () => {
    const wallet = await seedWallet(db.sql, '0.00');
    await insertRow(
      db.sql,
      'wager_transactions',
      transactionRow(wallet.walletId, wallet.playerId, { external_transaction_id: 'tx-123' }),
    );

    await expectPgError(
      () =>
        insertRow(
          db.sql,
          'wager_transactions',
          transactionRow(wallet.walletId, wallet.playerId, { external_transaction_id: 'tx-123' }),
        ),
      { sqlState: SqlState.UniqueViolation, constraint: 'wager_transactions_external_uq' },
    );
  });

  it.each([
    ['zero amount', { amount: '0.00' }, 'wager_transactions_amount_positive_ck'],
    ['unknown kind', { kind: 'JACKPOT' }, 'wager_transactions_kind_ck'],
    ['unknown status', { status: 'DONE', processed_at: null }, 'wager_transactions_status_ck'],
    ['malformed hash', { payload_hash: 'xyz' }, 'wager_transactions_payload_hash_format_ck'],
    ['REFUND without reference', { kind: 'REFUND' }, 'wager_transactions_reference_required_ck'],
    [
      'BET with a reference',
      { reference_external_transaction_id: 'other' },
      'wager_transactions_reference_forbidden_ck',
    ],
    [
      'OPENING from an external provider',
      { kind: 'OPENING' },
      'wager_transactions_opening_internal_ck',
    ],
    [
      'the internal provider submitting a BET',
      { provider_id: 'internal' },
      'wager_transactions_opening_internal_ck',
    ],
    [
      'REJECTED without failure code',
      { status: 'REJECTED', processed_at: null },
      'wager_transactions_failure_code_ck',
    ],
    [
      'PROCESSED with a failure code',
      { failure_code: 'INSUFFICIENT_FUNDS' },
      'wager_transactions_failure_code_ck',
    ],
    [
      'PROCESSED without processed_at',
      { processed_at: null },
      'wager_transactions_processed_at_ck',
    ],
    [
      'PENDING_REFERENCE without next attempt',
      {
        kind: 'WIN',
        reference_external_transaction_id: 'bet-later',
        status: 'PENDING_REFERENCE',
        processed_at: null,
      },
      'wager_transactions_next_attempt_ck',
    ],
    ['negative attempts', { attempts: -1 }, 'wager_transactions_attempts_ck'],
  ])('rejects %s', async (_, overrides, constraint) => {
    const wallet = await seedWallet(db.sql, '0.00');

    await expectPgError(
      () =>
        insertRow(
          db.sql,
          'wager_transactions',
          transactionRow(wallet.walletId, wallet.playerId, overrides),
        ),
      { sqlState: SqlState.CheckViolation, constraint },
    );
  });

  it('rejects a transaction for an unknown wallet', async () => {
    await expectPgError(
      () =>
        insertRow(
          db.sql,
          'wager_transactions',
          transactionRow(crypto.randomUUID(), crypto.randomUUID()),
        ),
      { sqlState: SqlState.ForeignKeyViolation },
    );
  });

  it('allows a single OPENING per wallet', async () => {
    const wallet = await seedWallet(db.sql, '100.00');

    await expectPgError(
      () =>
        insertRow(
          db.sql,
          'wager_transactions',
          transactionRow(wallet.walletId, wallet.playerId, {
            provider_id: 'internal',
            kind: 'OPENING',
          }),
        ),
      { sqlState: SqlState.UniqueViolation, constraint: 'wager_transactions_single_opening_uq' },
    );
  });

  describe('reversal uniqueness (D6)', () => {
    async function seedProcessedBet() {
      const wallet = await seedWallet(db.sql, '100.00');
      const betId = await applyDebit(db.sql, wallet, {
        amount: '25.00',
        balanceBefore: '100.00',
        balanceAfter: '75.00',
        newVersion: 2,
      });
      return { wallet, betId };
    }

    const reversal = (
      wallet: { walletId: string; playerId: string },
      betId: string,
      overrides: Record<string, unknown>,
    ) =>
      transactionRow(wallet.walletId, wallet.playerId, {
        reference_external_transaction_id: 'bet',
        reference_transaction_id: betId,
        ...overrides,
      });

    it('rejects a ROLLBACK of a BET that was already refunded', async () => {
      const { wallet, betId } = await seedProcessedBet();
      await insertRow(db.sql, 'wager_transactions', reversal(wallet, betId, { kind: 'REFUND' }));

      await expectPgError(
        () =>
          insertRow(db.sql, 'wager_transactions', reversal(wallet, betId, { kind: 'ROLLBACK' })),
        {
          sqlState: SqlState.UniqueViolation,
          constraint: 'wager_transactions_single_reversal_uq',
        },
      );
    });

    it('still records rejected reversal attempts for auditing', async () => {
      const { wallet, betId } = await seedProcessedBet();
      await insertRow(db.sql, 'wager_transactions', reversal(wallet, betId, { kind: 'REFUND' }));

      await insertRow(
        db.sql,
        'wager_transactions',
        transactionRow(wallet.walletId, wallet.playerId, {
          kind: 'ROLLBACK',
          reference_external_transaction_id: 'bet',
          status: 'REJECTED',
          failure_code: 'REFERENCE_ALREADY_REVERSED',
          processed_at: null,
        }),
      );
    });
  });
});

describe('wallet_ledger_entries', () => {
  async function seedWithEntry() {
    const wallet = await seedWallet(db.sql, '100.00');
    const rows: { id: string }[] = await db.sql.unsafe(
      'select id from wallet_ledger_entries where wallet_id = $1',
      [wallet.walletId],
    );
    const entryId = rows[0]?.id;
    if (!entryId) throw new Error('expected an opening entry');
    return { wallet, entryId };
  }

  it.each([
    [
      'UPDATE',
      (id: string) =>
        db.sql.unsafe(`update wallet_ledger_entries set amount = 1 where id = $1`, [id]),
    ],
    [
      'DELETE',
      (id: string) => db.sql.unsafe('delete from wallet_ledger_entries where id = $1', [id]),
    ],
    ['TRUNCATE', () => db.sql.unsafe('truncate wallet_ledger_entries cascade')],
  ])('is append-only: %s is rejected', async (operation, statement) => {
    const { entryId } = await seedWithEntry();

    await expectPgError(() => statement(entryId), {
      sqlState: SqlState.RestrictViolation,
      message: new RegExp(`append-only: ${operation}`),
    });
  });

  it('rejects unbalanced arithmetic', async () => {
    const wallet = await seedWallet(db.sql, '100.00');
    const bet = transactionRow(wallet.walletId, wallet.playerId);
    await insertRow(db.sql, 'wager_transactions', bet);

    await expectPgError(
      () =>
        insertRow(
          db.sql,
          'wallet_ledger_entries',
          ledgerRow({
            wallet_id: wallet.walletId,
            transaction_id: bet.id as string,
            balance_after: '80.00',
          }),
        ),
      { sqlState: SqlState.CheckViolation, constraint: 'wallet_ledger_entries_balanced_ck' },
    );
  });

  it('pins the entry currency to the wallet currency', async () => {
    const wallet = await seedWallet(db.sql, '100.00');
    const usdTransaction = transactionRow(wallet.walletId, wallet.playerId, {
      currency: 'USD',
      status: 'REJECTED',
      failure_code: 'CURRENCY_MISMATCH',
      processed_at: null,
    });
    await insertRow(db.sql, 'wager_transactions', usdTransaction);

    await expectPgError(
      () =>
        insertRow(
          db.sql,
          'wallet_ledger_entries',
          ledgerRow({
            wallet_id: wallet.walletId,
            transaction_id: usdTransaction.id as string,
            currency: 'USD',
          }),
        ),
      { sqlState: SqlState.ForeignKeyViolation, constraint: 'wallet_ledger_entries_wallet_fk' },
    );
  });

  it("rejects an entry pointing to another wallet's transaction", async () => {
    const wallet = await seedWallet(db.sql, '100.00');
    const other = await seedWallet(db.sql, '0.00');
    const foreignBet = transactionRow(other.walletId, other.playerId);
    await insertRow(db.sql, 'wager_transactions', foreignBet);

    await expectPgError(
      () =>
        insertRow(
          db.sql,
          'wallet_ledger_entries',
          ledgerRow({ wallet_id: wallet.walletId, transaction_id: foreignBet.id as string }),
        ),
      {
        sqlState: SqlState.ForeignKeyViolation,
        constraint: 'wallet_ledger_entries_transaction_fk',
      },
    );
  });

  it('allows at most one entry per transaction and wallet', async () => {
    const wallet = await seedWallet(db.sql, '100.00');
    const betId = await applyDebit(db.sql, wallet, {
      amount: '25.00',
      balanceBefore: '100.00',
      balanceAfter: '75.00',
      newVersion: 2,
    });

    await expectPgError(
      () =>
        insertRow(
          db.sql,
          'wallet_ledger_entries',
          ledgerRow({
            wallet_id: wallet.walletId,
            transaction_id: betId,
            balance_before: '75.00',
            balance_after: '50.00',
            wallet_version: 3,
          }),
        ),
      { sqlState: SqlState.UniqueViolation, constraint: 'wallet_ledger_entries_transaction_uq' },
    );
  });

  it('allows one entry per wallet version', async () => {
    const wallet = await seedWallet(db.sql, '100.00');
    const bet = transactionRow(wallet.walletId, wallet.playerId);
    await insertRow(db.sql, 'wager_transactions', bet);

    await expectPgError(
      () =>
        insertRow(
          db.sql,
          'wallet_ledger_entries',
          ledgerRow({
            wallet_id: wallet.walletId,
            transaction_id: bet.id as string,
            wallet_version: 1,
          }),
        ),
      { sqlState: SqlState.UniqueViolation, constraint: 'wallet_ledger_entries_version_uq' },
    );
  });

  it('rejects an entry that no balance change backs (at commit)', async () => {
    const wallet = await seedWallet(db.sql, '100.00');
    const bet = transactionRow(wallet.walletId, wallet.playerId);
    await insertRow(db.sql, 'wager_transactions', bet);

    await expectPgError(
      () =>
        insertRow(
          db.sql,
          'wallet_ledger_entries',
          ledgerRow({ wallet_id: wallet.walletId, transaction_id: bet.id as string }),
        ),
      { sqlState: SqlState.CheckViolation, message: /beyond the wallet state/ },
    );
  });
});

describe('inbox_messages', () => {
  const inboxRow = (overrides: Record<string, unknown> = {}) => ({
    consumer_name: 'wager-transactions-consumer',
    message_id: `msg-${crypto.randomUUID()}`,
    payload_hash: HASH,
    received_at: new Date(),
    ...overrides,
  });

  it('deduplicates by consumer and message id', async () => {
    const row = inboxRow();
    await insertRow(db.sql, 'inbox_messages', row);

    await expectPgError(
      () => insertRow(db.sql, 'inbox_messages', inboxRow({ message_id: row.message_id })),
      {
        sqlState: SqlState.UniqueViolation,
        constraint: 'inbox_messages_pk',
      },
    );
  });

  it('allows the same message id for another consumer', async () => {
    const row = inboxRow();
    await insertRow(db.sql, 'inbox_messages', row);

    await insertRow(
      db.sql,
      'inbox_messages',
      inboxRow({ message_id: row.message_id, consumer_name: 'another-consumer' }),
    );
  });

  it('rejects a malformed payload hash', async () => {
    await expectPgError(
      () => insertRow(db.sql, 'inbox_messages', inboxRow({ payload_hash: 'x' })),
      {
        sqlState: SqlState.CheckViolation,
        constraint: 'inbox_messages_payload_hash_format_ck',
      },
    );
  });
});

describe('outbox_messages', () => {
  it('rejects negative attempts', async () => {
    await expectPgError(
      () =>
        insertRow(db.sql, 'outbox_messages', {
          id: crypto.randomUUID(),
          aggregate_id: 'wallet-1',
          event_type: 'WalletBalanceChanged',
          payload: JSON.stringify({}),
          occurred_at: new Date(),
          attempts: -1,
        }),
      { sqlState: SqlState.CheckViolation, constraint: 'outbox_messages_attempts_ck' },
    );
  });
});
