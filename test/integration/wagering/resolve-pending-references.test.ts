import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { type FaultInjector, type FaultPoint } from '../../../src/application/ports/fault-injector';
import { type UnitOfWork } from '../../../src/application/ports/unit-of-work';
import {
  ResolvePendingReferences,
  type ResolvePendingReferencesResult,
} from '../../../src/application/wagering/resolve-pending-references';
import { SubmitWagerTransaction } from '../../../src/application/wagering/submit-wager-transaction';
import {
  type PendingReferencePolicy,
  type SubmitWagerCommand,
} from '../../../src/application/wagering/wager-command';
import { CreateWallet } from '../../../src/application/wallets/create-wallet';
import { type WalletView } from '../../../src/application/wallets/wallet-views';
import { FailureCode } from '../../../src/domain/shared/failure-code';
import { WagerTransactionKind as Kind } from '../../../src/domain/wagering/wager-transaction-kind';
import { WagerTransactionStatus as Status } from '../../../src/domain/wagering/wager-transaction-status';
import { PrometheusMetrics } from '../../../src/infrastructure/observability/prometheus-metrics';
import { MikroOrmWagerTransactionRepository } from '../../../src/infrastructure/persistence/mikro-orm-repositories';
import { MikroOrmUnitOfWork } from '../../../src/infrastructure/persistence/mikro-orm-unit-of-work';
import { SystemClock, UuidV7IdGenerator } from '../../../src/infrastructure/system/system.adapters';
import { uuid } from '../support/domain-fixtures';
import { expectLedgerConsistent } from '../support/invariants';
import { createTestDatabase, type TestDatabase } from '../support/test-database';
import { RecordingLogger } from '../support/test-loggers';

/** Retries far away: only expediting (a reference reaching a terminal state) makes rows due. */
const SLOW: PendingReferencePolicy = {
  backoff: { baseMs: 60_000, capMs: 60_000 },
  maxAttempts: 10,
};
/** Retries within milliseconds, three attempts in total (the submission is attempt 1). */
const FAST: PendingReferencePolicy = { backoff: { baseMs: 20, capMs: 40 }, maxAttempts: 3 };
/** Retried continuously: rows stay due (and get locked by workers) while references arrive. */
const BUSY: PendingReferencePolicy = { backoff: { baseMs: 5, capMs: 10 }, maxAttempts: 10_000 };
const CONTEXT = { correlationId: 'corr-test' };

let db: TestDatabase;
let unitOfWork: UnitOfWork;
let createWallet: CreateWallet;
const ids = new UuidV7IdGenerator();
const clock = new SystemClock();

beforeAll(async () => {
  db = await createTestDatabase('resolve_pending');
  unitOfWork = new MikroOrmUnitOfWork(db.orm);
  createWallet = new CreateWallet(unitOfWork, ids, clock);
});

afterAll(async () => {
  await db.close();
});

// The worker takes any due row in the database: park what earlier tests left behind.
beforeEach(async () => {
  await db.sql.unsafe(
    `update wager_transactions set next_attempt_at = now() + interval '1 day'
      where status = 'PENDING_REFERENCE'`,
  );
});

// ---- helpers

/** Throws (instead of killing the process) at the given point, a limited number of times. */
class ThrowingFaults implements FaultInjector {
  constructor(
    private readonly point: FaultPoint,
    private remaining: number,
  ) {}
  trigger(point: FaultPoint): void {
    if (point !== this.point || this.remaining <= 0) return;
    this.remaining--;
    throw new Error(`simulated failure at ${point}`);
  }
}

const NO_FAULTS: FaultInjector = { trigger: () => undefined };

function worker(
  policy: PendingReferencePolicy,
  options: { batchSize?: number; faults?: FaultInjector } = {},
) {
  const metrics = new PrometheusMetrics();
  const logger = new RecordingLogger();
  const resolver = new ResolvePendingReferences(
    unitOfWork,
    ids,
    clock,
    policy,
    metrics,
    logger,
    options.faults ?? NO_FAULTS,
    { batchSize: options.batchSize ?? 20 },
  );
  return { resolver, metrics, logger };
}

const submitter = (policy: PendingReferencePolicy) =>
  new SubmitWagerTransaction(unitOfWork, ids, clock, policy);

const openWallet = (amount = '100.00'): Promise<WalletView> =>
  createWallet.execute({ playerId: uuid(), initialBalance: { amount, currency: 'BRL' } }, CONTEXT);

function command(
  wallet: WalletView,
  kind: Kind,
  overrides: Partial<SubmitWagerCommand> = {},
): SubmitWagerCommand {
  const externalTransactionId =
    overrides.externalTransactionId ?? `${kind.toLowerCase()}-${uuid()}`;
  // One provider per wallet: each test gets its own id namespace, so readable ids never clash.
  const providerId = `provider-${wallet.id}`;
  return {
    providerId,
    externalTransactionId,
    idempotencyKey: `${providerId}:${externalTransactionId}`,
    playerId: wallet.playerId,
    walletId: wallet.id,
    roundId: 'round-1',
    gameId: 'fortune-chimp',
    kind,
    money: { amount: '25.00', currency: 'BRL' },
    ...overrides,
  };
}

interface Row {
  status: string;
  failure_code: string | null;
  attempts: number;
  due_in_seconds: number | null;
}

async function row(transactionId: string): Promise<Row> {
  const rows: Row[] = await db.sql.unsafe(
    `select status, failure_code, attempts,
            extract(epoch from next_attempt_at - now())::float8 as due_in_seconds
       from wager_transactions where id = $1`,
    [transactionId],
  );
  const found = rows[0];
  if (!found) throw new Error(`transaction ${transactionId} not found`);
  return found;
}

async function events(transactionId: string): Promise<Record<string, unknown>[]> {
  const rows: { payload: Record<string, unknown> }[] = await db.sql.unsafe(
    `select payload from outbox_messages
      where aggregate_id = $1 or payload -> 'data' ->> 'transactionId' = $1
      order by occurred_at, event_type`,
    [transactionId],
  );
  return rows.map((r) => r.payload);
}

const eventTypes = async (transactionId: string) =>
  (await events(transactionId)).map((event) => event.eventType);

async function balanceOf(walletId: string): Promise<string> {
  const rows: { balance: string }[] = await db.sql.unsafe(
    'select balance::text as balance from wallets where id = $1',
    [walletId],
  );
  return rows[0]?.balance ?? 'missing';
}

type Totals = Omit<ResolvePendingReferencesResult, 'attempted'> & { attempted: number };
const emptyTotals = (): Totals => ({
  attempted: 0,
  processed: 0,
  rejected: 0,
  rescheduled: 0,
  failed: 0,
});

/** Runs the given workers side by side, pass after pass, until `done()` or the timeout. */
async function runUntil(
  workers: ResolvePendingReferences[],
  done: () => Promise<boolean>,
  timeoutMs = 20_000,
): Promise<Totals> {
  const totals = emptyTotals();
  const deadline = Date.now() + timeoutMs;
  while (!(await done())) {
    if (Date.now() > deadline) throw new Error('pending transactions did not settle in time');
    const results = await Promise.all(workers.map((w) => w.runOnce()));
    for (const result of results) {
      for (const key of Object.keys(totals) as (keyof Totals)[]) totals[key] += result[key];
    }
    if (results.every((result) => result.attempted === 0)) await Bun.sleep(10);
  }
  return totals;
}

const allTerminal = (transactionIds: string[]) => async () => {
  const rows: { pending: number }[] = await db.sql.unsafe(
    `select count(*)::int as pending from wager_transactions
      where id = any($1::uuid[]) and status = 'PENDING_REFERENCE'`,
    [transactionIds],
  );
  return rows[0]?.pending === 0;
};

/** Resolves once some session of this database is blocked waiting for a row lock. */
async function waitForLockWait(timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const rows: { waiting: number }[] = await db.sql.unsafe(
      `select count(*)::int as waiting from pg_stat_activity
        where datname = current_database() and wait_event_type = 'Lock'`,
    );
    if ((rows[0]?.waiting ?? 0) > 0) return;
    if (Date.now() > deadline) throw new Error('no session ever waited for a lock');
    await Bun.sleep(10);
  }
}

// ---- tests

describe('a reference that arrives late', () => {
  it('processes the REFUND once its BET arrives: balance, events, ledger and replay', async () => {
    const submit = submitter(SLOW);
    const { resolver, metrics } = worker(SLOW);
    const wallet = await openWallet('100.00');
    const refundCommand = command(wallet, Kind.Refund, { referenceExternalTransactionId: 'bet-1' });

    const refund = await submit.execute(refundCommand, CONTEXT);
    expect(refund.status).toBe(Status.PendingReference);
    expect((await resolver.runOnce()).attempted).toBe(0); // not due: retry in 60s

    await submit.execute(command(wallet, Kind.Bet, { externalTransactionId: 'bet-1' }), CONTEXT);
    // The BET reaching PROCESSED made the waiting REFUND due right away.
    expect((await row(refund.transactionId)).due_in_seconds).toBeLessThanOrEqual(0);

    expect(await resolver.runOnce()).toMatchObject({ attempted: 1, processed: 1 });
    expect(await row(refund.transactionId)).toMatchObject({
      status: Status.Processed,
      failure_code: null,
      due_in_seconds: null,
    });
    expect(await balanceOf(wallet.id)).toBe('100.00');
    expect(await eventTypes(refund.transactionId)).toEqual([
      'WagerTransactionPendingReference',
      'WagerTransactionProcessed',
      'WalletBalanceChanged',
    ]);
    await expectLedgerConsistent(db.sql, wallet.id);
    expect(
      await metrics.counterValue('pending_reference_attempts_total', { outcome: 'processed' }),
    ).toBe(1);

    // Events of the resolution: new correlation, caused by the waiting transaction.
    const resolution = (await events(refund.transactionId)).slice(1);
    for (const event of resolution) {
      expect(event.causationId).toBe(refund.transactionId);
      expect(event.correlationId).not.toBe(CONTEXT.correlationId);
    }

    // The provider resending the REFUND gets the current state, not the original 202.
    const replay = await submit.execute(refundCommand, CONTEXT);
    expect(replay).toMatchObject({
      transactionId: refund.transactionId,
      status: Status.Processed,
      idempotentReplay: true,
      balance: { amount: '100.00', currency: 'BRL' },
    });
  });

  it('resolves an out-of-order chain (ROLLBACK -> WIN -> BET) in a single pass', async () => {
    const submit = submitter(SLOW);
    const { resolver } = worker(SLOW);
    const wallet = await openWallet('100.00');
    const win = { amount: '40.00', currency: 'BRL' };

    const rollback = await submit.execute(
      command(wallet, Kind.Rollback, { money: win, referenceExternalTransactionId: 'win-1' }),
      CONTEXT,
    );
    const winResult = await submit.execute(
      command(wallet, Kind.Win, {
        externalTransactionId: 'win-1',
        money: win,
        referenceExternalTransactionId: 'bet-1',
      }),
      CONTEXT,
    );
    expect(rollback.status).toBe(Status.PendingReference);
    expect(winResult.status).toBe(Status.PendingReference);

    await submit.execute(command(wallet, Kind.Bet, { externalTransactionId: 'bet-1' }), CONTEXT);
    // BET expedites the WIN; the WIN, once processed, expedites the ROLLBACK in the same pass.
    expect(await resolver.runOnce()).toMatchObject({ attempted: 2, processed: 2 });

    expect((await row(winResult.transactionId)).status).toBe(Status.Processed);
    expect((await row(rollback.transactionId)).status).toBe(Status.Processed);
    expect(await balanceOf(wallet.id)).toBe('75.00'); // 100 - 25 + 40 - 40
    await expectLedgerConsistent(db.sql, wallet.id);
  });

  it('rejects a waiting REFUND right away when its BET is rejected', async () => {
    const submit = submitter(SLOW);
    const { resolver } = worker(SLOW);
    const wallet = await openWallet('10.00');

    const refund = await submit.execute(
      command(wallet, Kind.Refund, { referenceExternalTransactionId: 'bet-1' }),
      CONTEXT,
    );
    const bet = await submit.execute(
      command(wallet, Kind.Bet, { externalTransactionId: 'bet-1' }),
      CONTEXT,
    );
    expect(bet.failureCode).toBe(FailureCode.InsufficientFunds);

    expect(await resolver.runOnce()).toMatchObject({ attempted: 1, rejected: 1 });
    expect(await row(refund.transactionId)).toMatchObject({
      status: Status.Rejected,
      failure_code: FailureCode.ReferenceNotProcessed,
      attempts: 1, // a decided reference is not a failed lookup
    });
    expect(await eventTypes(refund.transactionId)).toEqual([
      'WagerTransactionPendingReference',
      'WagerTransactionRejected',
    ]);
    expect(await balanceOf(wallet.id)).toBe('10.00');
    await expectLedgerConsistent(db.sql, wallet.id);
  });
});

describe('scheduling', () => {
  it('schedules on the database clock and leaves transactions alone until due', async () => {
    const submit = submitter(SLOW);
    const { resolver } = worker(SLOW);
    const wallet = await openWallet();

    const refund = await submit.execute(
      command(wallet, Kind.Refund, { referenceExternalTransactionId: 'bet-later' }),
      CONTEXT,
    );

    const pending = await row(refund.transactionId);
    expect(pending.attempts).toBe(1);
    // database now() + 60s, measured against the database clock itself.
    expect(pending.due_in_seconds).toBeGreaterThan(55);
    expect(pending.due_in_seconds).toBeLessThanOrEqual(60);
    expect((await resolver.runOnce()).attempted).toBe(0);
    expect((await row(refund.transactionId)).status).toBe(Status.PendingReference);
  });

  it('retries with backoff, then rejects with REFERENCE_NOT_FOUND after the last attempt', async () => {
    const submit = submitter(FAST);
    const { resolver, metrics, logger } = worker(FAST);
    const wallet = await openWallet();

    const refund = await submit.execute(
      command(wallet, Kind.Refund, { referenceExternalTransactionId: 'never-sent' }),
      CONTEXT,
    );
    const totals = await runUntil([resolver], allTerminal([refund.transactionId]));

    expect(totals).toMatchObject({ rescheduled: 1, rejected: 1, failed: 0 });
    expect(await row(refund.transactionId)).toMatchObject({
      status: Status.Rejected,
      failure_code: FailureCode.ReferenceNotFound,
      attempts: FAST.maxAttempts,
      due_in_seconds: null,
    });
    // Arrival and outcome only: the intermediate retry published nothing.
    expect(await eventTypes(refund.transactionId)).toEqual([
      'WagerTransactionPendingReference',
      'WagerTransactionRejected',
    ]);
    const [, rejected] = await events(refund.transactionId);
    expect(rejected?.data).toMatchObject({
      failureCode: FailureCode.ReferenceNotFound,
      status: Status.Rejected,
    });
    expect(
      await metrics.counterValue('pending_reference_attempts_total', { outcome: 'rejected' }),
    ).toBe(1);
    expect(await balanceOf(wallet.id)).toBe('100.00');
    await expectLedgerConsistent(db.sql, wallet.id);
    // Each attempt logs in its own scope, carrying the transaction it works on (README §12).
    const rejection = logger.warnings.find(
      (line) => line.message === 'Pending transaction rejected',
    );
    expect(rejection?.context).toMatchObject({
      transactionId: refund.transactionId,
      walletId: wallet.id,
      providerId: `provider-${wallet.id}`,
    });
    expect(rejection?.context.correlationId).toBeString();
  });

  it('rejects the whole chain when its root never arrives', async () => {
    const submit = submitter(FAST);
    const { resolver } = worker(FAST);
    const wallet = await openWallet();

    const winResult = await submit.execute(
      command(wallet, Kind.Win, {
        externalTransactionId: 'win-orphan',
        referenceExternalTransactionId: 'bet-never',
      }),
      CONTEXT,
    );
    const rollback = await submit.execute(
      command(wallet, Kind.Rollback, { referenceExternalTransactionId: 'win-orphan' }),
      CONTEXT,
    );
    await runUntil([resolver], allTerminal([winResult.transactionId, rollback.transactionId]));

    expect(await row(winResult.transactionId)).toMatchObject({
      status: Status.Rejected,
      failure_code: FailureCode.ReferenceNotFound,
    });
    // The WIN exists but never got processed.
    expect(await row(rollback.transactionId)).toMatchObject({
      status: Status.Rejected,
      failure_code: FailureCode.ReferenceNotProcessed,
    });
    expect(await balanceOf(wallet.id)).toBe('100.00');
    await expectLedgerConsistent(db.sql, wallet.id);
  });
});

describe('failures', () => {
  it('rolls a failed attempt back and defers it without counting an attempt', async () => {
    const submit = submitter(SLOW);
    const faults = new ThrowingFaults('pending:before-commit', 1);
    const { resolver, metrics, logger } = worker(SLOW, { faults });
    const wallet = await openWallet('100.00');

    const refund = await submit.execute(
      command(wallet, Kind.Refund, { referenceExternalTransactionId: 'bet-1' }),
      CONTEXT,
    );
    await submit.execute(command(wallet, Kind.Bet, { externalTransactionId: 'bet-1' }), CONTEXT);

    // The attempt applied the REFUND, then failed before COMMIT.
    expect(await resolver.runOnce()).toMatchObject({ attempted: 1, failed: 1, processed: 0 });

    const deferred = await row(refund.transactionId);
    expect(deferred).toMatchObject({ status: Status.PendingReference, attempts: 1 });
    expect(deferred.due_in_seconds).toBeGreaterThan(55); // backoff on the database clock
    expect(await balanceOf(wallet.id)).toBe('75.00'); // the credit was rolled back
    expect(await eventTypes(refund.transactionId)).toEqual(['WagerTransactionPendingReference']);
    await expectLedgerConsistent(db.sql, wallet.id);
    expect(await metrics.counterValue('pending_reference_failures_total')).toBe(1);
    expect(
      logger.lines.some(
        (line) =>
          line.level === 'error' && line.message === 'Pending reference attempt failed, deferred',
      ),
    ).toBe(true);
    // Deferred: not picked again before its new time.
    expect((await resolver.runOnce()).attempted).toBe(0);
  });
});

describe('concurrency', () => {
  it('expediting skips a row a worker holds, so the two lock orders cannot deadlock', async () => {
    // Deterministic interleaving of the hazard: a submission whose transaction started BEFORE
    // the refund became due holds the wallet; the worker then locks the refund and waits for
    // that wallet; finally the submission expedites the refund. Waiting there would close a
    // cycle (worker -> wallet -> submission -> refund -> worker).
    const policy: PendingReferencePolicy = {
      backoff: { baseMs: 300, capMs: 300 },
      maxAttempts: 10,
    };
    const submit = submitter(policy);
    const { resolver } = worker(policy);
    const wallet = await openWallet();
    const refundCommand = command(wallet, Kind.Refund, { referenceExternalTransactionId: 'bet-1' });
    await submit.execute(refundCommand, CONTEXT);

    const worker1: { attempt?: Promise<ResolvePendingReferencesResult> } = {};
    const started = Date.now();
    const expedited = await db.orm.em.fork().transactional(async (em) => {
      await em.execute('select id from wallets where id = ? for update', [wallet.id]);
      await Bun.sleep(400); // the refund becomes due
      worker1.attempt = resolver.runOnce(); // locks the refund row, then waits for the wallet
      await waitForLockWait();
      return new MikroOrmWagerTransactionRepository(em).expediteDependents(
        refundCommand.providerId,
        'bet-1',
      );
    });

    expect(expedited).toBe(0); // skipped instead of waiting
    expect(Date.now() - started).toBeLessThan(1_000); // no wait for deadlock detection
    expect(await worker1.attempt).toMatchObject({ attempted: 1, rescheduled: 1, failed: 0 });
  });

  it('two workers never process the same transaction', async () => {
    const submit = submitter(SLOW);
    const workers = [worker(SLOW, { batchSize: 5 }), worker(SLOW, { batchSize: 5 })];
    const wallets = await Promise.all([
      openWallet('1000.00'),
      openWallet('1000.00'),
      openWallet('1000.00'),
    ]);

    const refunds: string[] = [];
    for (const wallet of wallets) {
      for (let i = 0; i < 10; i++) {
        const betId = `bet-${uuid()}`;
        const refund = await submit.execute(
          command(wallet, Kind.Refund, { referenceExternalTransactionId: betId }),
          CONTEXT,
        );
        refunds.push(refund.transactionId);
        await submit.execute(command(wallet, Kind.Bet, { externalTransactionId: betId }), CONTEXT);
      }
    }

    const totals = await runUntil(
      workers.map((w) => w.resolver),
      allTerminal(refunds),
    );

    expect(totals).toMatchObject({ attempted: 30, processed: 30, rescheduled: 0, failed: 0 });
    const processedEvents: { count: number }[] = await db.sql.unsafe(
      `select count(*)::int as count from outbox_messages
        where event_type = 'WagerTransactionProcessed' and aggregate_id = any($1::text[])`,
      [refunds],
    );
    expect(processedEvents[0]?.count).toBe(30);
    for (const wallet of wallets) {
      expect(await balanceOf(wallet.id)).toBe('1000.00');
      await expectLedgerConsistent(db.sql, wallet.id);
    }
  });

  it('submissions and workers on the same wallet run together without deadlocks', async () => {
    // Workers hold due pending rows (then wait for the wallet) while each BET submission holds
    // the wallet and expedites those same rows: the lock-order hazard SKIP LOCKED prevents.
    const submit = submitter(BUSY);
    const workers = [worker(BUSY, { batchSize: 3 }), worker(BUSY, { batchSize: 3 })];
    const wallet = await openWallet('1000.00');

    const betIds = Array.from({ length: 15 }, () => `bet-${uuid()}`);
    const refunds: string[] = [];
    for (const betId of betIds) {
      const refund = await submit.execute(
        command(wallet, Kind.Refund, { referenceExternalTransactionId: betId }),
        CONTEXT,
      );
      refunds.push(refund.transactionId);
    }

    // Bets arrive concurrently while both workers are resolving the refunds they unlock.
    const [submissions, totals] = await Promise.all([
      Promise.allSettled(
        betIds.map((betId) =>
          submit.execute(command(wallet, Kind.Bet, { externalTransactionId: betId }), CONTEXT),
        ),
      ),
      runUntil(
        workers.map((w) => w.resolver),
        allTerminal(refunds),
      ),
    ]);

    expect(submissions.filter((s) => s.status === 'rejected')).toEqual([]);
    expect(totals).toMatchObject({ processed: 15, failed: 0 });
    for (const w of workers) {
      expect(w.logger.lines.filter((line) => line.level !== 'info')).toEqual([]);
    }
    expect(await balanceOf(wallet.id)).toBe('1000.00');
    await expectLedgerConsistent(db.sql, wallet.id);
  });
});
