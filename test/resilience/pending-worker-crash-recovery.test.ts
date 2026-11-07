import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { SubmitWagerTransaction } from '../../src/application/wagering/submit-wager-transaction';
import { type SubmitWagerCommand } from '../../src/application/wagering/wager-command';
import { CreateWallet } from '../../src/application/wallets/create-wallet';
import { WagerTransactionKind as Kind } from '../../src/domain/wagering/wager-transaction-kind';
import { PrometheusMetrics } from '../../src/infrastructure/observability/prometheus-metrics';
import { MikroOrmUnitOfWork } from '../../src/infrastructure/persistence/mikro-orm-unit-of-work';
import { SystemClock, UuidV7IdGenerator } from '../../src/infrastructure/system/system.adapters';
import { type Instance, spawnInstance, waitUntilLive } from '../concurrency/support/instances';
import { expectLedgerConsistent } from '../integration/support/invariants';
import { createTestDatabase, type TestDatabase } from '../integration/support/test-database';

/**
 * A pending-reference worker dies (SIGKILL) after applying a REFUND inside its SQL transaction
 * and before COMMIT. Nothing may survive the crash: no credit, no ledger entry, no event, no
 * spent attempt, and no lock left behind. Another instance then resolves it exactly once.
 */
let db: TestDatabase;
const running: Instance[] = [];

beforeAll(async () => {
  db = await createTestDatabase('resilience_pending');
});

afterAll(async () => {
  for (const instance of running) instance.process.kill();
  await Promise.all(running.map((instance) => instance.process.exited));
  await db.close();
});

const pendingInstance = (overrides: Record<string, string> = {}) => {
  const instance = spawnInstance(db.env, {
    APP_ROLES: 'pending',
    PENDING_REFERENCE_POLL_INTERVAL_MS: '100',
    ...overrides,
  });
  running.push(instance);
  return instance;
};

async function one<T>(sql: string, params: unknown[]): Promise<T> {
  const rows: T[] = await db.sql.unsafe(sql, params);
  const row = rows[0];
  if (!row) throw new Error('query returned no row');
  return row;
}

describe('pending-reference worker crash before commit (real processes)', () => {
  it('rolls the attempt back entirely and another instance resolves it once', async () => {
    const unitOfWork = new MikroOrmUnitOfWork(db.orm);
    const ids = new UuidV7IdGenerator();
    const clock = new SystemClock();
    // Retries a minute away: only the BET arriving (expediting) makes the REFUND due.
    const submit = new SubmitWagerTransaction(
      unitOfWork,
      ids,
      clock,
      {
        backoff: { baseMs: 60_000, capMs: 60_000 },
        maxAttempts: 10,
      },
      new PrometheusMetrics(),
    );
    const wallet = await new CreateWallet(unitOfWork, ids, clock).execute(
      { playerId: crypto.randomUUID(), initialBalance: { amount: '100.00', currency: 'BRL' } },
      { correlationId: 'corr-resilience' },
    );
    const base: Omit<SubmitWagerCommand, 'externalTransactionId' | 'idempotencyKey' | 'kind'> = {
      providerId: 'provider-a',
      playerId: wallet.playerId,
      walletId: wallet.id,
      roundId: 'round-1',
      gameId: 'fortune-chimp',
      money: { amount: '25.00', currency: 'BRL' },
    };
    const context = { correlationId: 'corr-resilience' };

    const refund = await submit.execute(
      {
        ...base,
        externalTransactionId: 'refund-1',
        idempotencyKey: 'provider-a:refund-1',
        kind: Kind.Refund,
        referenceExternalTransactionId: 'bet-1',
      },
      context,
    );
    await submit.execute(
      {
        ...base,
        externalTransactionId: 'bet-1',
        idempotencyKey: 'provider-a:bet-1',
        kind: Kind.Bet,
      },
      context,
    );
    const state = () =>
      one<{ status: string; attempts: number; credits: number; events: number; balance: string }>(
        `select t.status, t.attempts,
                (select count(*)::int from wallet_ledger_entries
                  where transaction_id = t.id) as credits,
                (select count(*)::int from outbox_messages
                  where aggregate_id = t.id::text
                     or payload -> 'data' ->> 'transactionId' = t.id::text) as events,
                (select balance::text from wallets where id = t.wallet_id) as balance
           from wager_transactions t where t.id = $1`,
        [refund.transactionId],
      );
    expect(await state()).toMatchObject({ status: 'PENDING_REFERENCE', balance: '75.00' });

    // 1. The worker applies the REFUND, then SIGKILL before COMMIT.
    const victim = pendingInstance({ FAULT_INJECTION: 'pending:before-commit' });
    expect(await victim.process.exited).not.toBe(0);

    // 2. Nothing of the attempt survived, and the row is not left locked.
    expect(await state()).toEqual({
      status: 'PENDING_REFERENCE',
      attempts: 1,
      credits: 0,
      events: 1, // only the WagerTransactionPendingReference of the submission
      balance: '75.00',
    });
    const locked = await one<{ locked: boolean }>(
      `select not exists (
         select 1 from wager_transactions where id = $1 for update skip locked) as locked`,
      [refund.transactionId],
    );
    expect(locked.locked).toBe(false);

    // 3. Another instance resolves it, exactly once.
    const survivor = pendingInstance();
    await waitUntilLive(survivor.url, survivor.process);
    const deadline = Date.now() + 20_000;
    while ((await state()).status !== 'PROCESSED') {
      if (Date.now() > deadline) throw new Error('the REFUND was not resolved in time');
      await Bun.sleep(100);
    }
    expect(await state()).toEqual({
      status: 'PROCESSED',
      attempts: 1,
      credits: 1,
      events: 3, // PendingReference, then Processed + WalletBalanceChanged
      balance: '100.00',
    });
    await expectLedgerConsistent(db.sql, wallet.id);

    survivor.process.kill();
    await survivor.process.exited;
  }, 60_000);
});
