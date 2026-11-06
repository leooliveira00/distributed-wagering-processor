import { MikroORM } from '@mikro-orm/postgresql';
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import {
  ConflictError,
  InvalidRequestError,
  NotFoundError,
  TransientError,
} from '../../../src/application/errors';
import { type UnitOfWork } from '../../../src/application/ports/unit-of-work';
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
import { InvalidWagerTransactionError } from '../../../src/domain/wagering/wagering.errors';
import { buildMikroOrmConfig } from '../../../src/infrastructure/persistence/mikro-orm.config';
import { MikroOrmUnitOfWork } from '../../../src/infrastructure/persistence/mikro-orm-unit-of-work';
import { SystemClock, UuidV7IdGenerator } from '../../../src/infrastructure/system/system.adapters';
import { uuid } from '../support/domain-fixtures';
import { expectLedgerConsistent } from '../support/invariants';
import { captureError, createTestDatabase, type TestDatabase } from '../support/test-database';

const POLICY: PendingReferencePolicy = {
  backoff: { baseMs: 1_000, capMs: 60_000 },
  maxAttempts: 10,
};
const CONTEXT = { correlationId: 'corr-test' };

let db: TestDatabase;
let unitOfWork: UnitOfWork;
let submit: SubmitWagerTransaction;
let createWallet: CreateWallet;

beforeAll(async () => {
  db = await createTestDatabase('submit_wager');
  unitOfWork = new MikroOrmUnitOfWork(db.orm);
  submit = new SubmitWagerTransaction(
    unitOfWork,
    new UuidV7IdGenerator(),
    new SystemClock(),
    POLICY,
  );
  createWallet = new CreateWallet(unitOfWork, new UuidV7IdGenerator(), new SystemClock());
});

afterAll(async () => {
  await db.close();
});

const openWallet = (amount = '100.00'): Promise<WalletView> =>
  createWallet.execute({ playerId: uuid(), initialBalance: { amount, currency: 'BRL' } }, CONTEXT);

function command(
  wallet: WalletView,
  overrides: Partial<SubmitWagerCommand> = {},
): SubmitWagerCommand {
  const externalTransactionId = overrides.externalTransactionId ?? `tx-${uuid()}`;
  return {
    providerId: 'provider-a',
    externalTransactionId,
    idempotencyKey: `provider-a:${externalTransactionId}`,
    playerId: wallet.playerId,
    walletId: wallet.id,
    roundId: 'round-987',
    gameId: 'fortune-chimp',
    kind: Kind.Bet,
    money: { amount: '25.00', currency: 'BRL' },
    ...overrides,
  };
}

const eventsOf = async (transactionId: string): Promise<string[]> => {
  const rows: { event_type: string }[] = await db.sql.unsafe(
    `select event_type from outbox_messages
      where aggregate_id = $1 or payload -> 'data' ->> 'transactionId' = $1
      order by event_type`,
    [transactionId],
  );
  return rows.map((row) => row.event_type);
};

describe('processing', () => {
  it('debits a BET and writes its events in the same commit', async () => {
    const wallet = await openWallet('100.00');

    const result = await submit.execute(command(wallet), CONTEXT);

    expect(result).toEqual({
      transactionId: result.transactionId,
      status: Status.Processed,
      balance: { amount: '75.00', currency: 'BRL' },
      idempotentReplay: false,
      failureCode: null,
    });
    expect(await eventsOf(result.transactionId)).toEqual([
      'WagerTransactionProcessed',
      'WalletBalanceChanged',
    ]);
    await expectLedgerConsistent(db.sql, wallet.id);
  });

  it('persists a rejection with its event and no ledger entry', async () => {
    const wallet = await openWallet('10.00');

    const result = await submit.execute(command(wallet), CONTEXT);

    expect(result).toMatchObject({
      status: Status.Rejected,
      failureCode: FailureCode.InsufficientFunds,
      balance: { amount: '10.00', currency: 'BRL' },
    });
    expect(await eventsOf(result.transactionId)).toEqual(['WagerTransactionRejected']);
    await expectLedgerConsistent(db.sql, wallet.id);
  });

  it('accepts a reversal that arrives before its reference as PENDING_REFERENCE', async () => {
    const wallet = await openWallet('100.00');
    const before = Date.now();

    const result = await submit.execute(
      command(wallet, { kind: Kind.Refund, referenceExternalTransactionId: 'bet-not-yet' }),
      CONTEXT,
    );

    expect(result.status).toBe(Status.PendingReference);
    expect(await eventsOf(result.transactionId)).toEqual(['WagerTransactionPendingReference']);
    const rows: { attempts: number; next_attempt_at: Date }[] = await db.sql.unsafe(
      'select attempts, next_attempt_at from wager_transactions where id = $1',
      [result.transactionId],
    );
    expect(rows[0]?.attempts).toBe(1);
    const delay = (rows[0]?.next_attempt_at.getTime() ?? 0) - before;
    expect(delay).toBeGreaterThanOrEqual(900);
    expect(delay).toBeLessThan(5_000);
  });

  it('reverses a BET once and rejects any further reversal of it (D6)', async () => {
    const wallet = await openWallet('100.00');
    const bet = command(wallet, { externalTransactionId: `bet-${uuid()}` });
    await submit.execute(bet, CONTEXT);
    const reversal = (kind: Kind) =>
      command(wallet, { kind, referenceExternalTransactionId: bet.externalTransactionId });

    const refund = await submit.execute(reversal(Kind.Refund), CONTEXT);
    const secondRefund = await submit.execute(reversal(Kind.Refund), CONTEXT);
    const rollback = await submit.execute(reversal(Kind.Rollback), CONTEXT);

    expect(refund).toMatchObject({ status: Status.Processed, balance: { amount: '100.00' } });
    expect(secondRefund.failureCode).toBe(FailureCode.ReferenceAlreadyReversed);
    expect(rollback.failureCode).toBe(FailureCode.ReferenceAlreadyReversed);
    await expectLedgerConsistent(db.sql, wallet.id);
  });
});

describe('idempotency', () => {
  it('replays an identical submission with the ORIGINAL observed balance (rule 7.7)', async () => {
    const wallet = await openWallet('100.00');
    const first = command(wallet);
    const original = await submit.execute(first, CONTEXT);
    await submit.execute(command(wallet), CONTEXT); // balance moves on to 50.00

    const replay = await submit.execute(first, CONTEXT);

    expect(replay).toEqual({ ...original, idempotentReplay: true });
    expect(replay.balance).toEqual({ amount: '75.00', currency: 'BRL' });
  });

  it('does not produce new events on replay', async () => {
    const wallet = await openWallet('100.00');
    const first = command(wallet);
    const original = await submit.execute(first, CONTEXT);

    await submit.execute(first, CONTEXT);

    expect(await eventsOf(original.transactionId)).toHaveLength(2);
  });

  it('treats the same key with a different payload as a conflict, not a replay', async () => {
    const wallet = await openWallet('100.00');
    const first = command(wallet);
    await submit.execute(first, CONTEXT);

    const error = await captureError(
      submit.execute({ ...first, money: { amount: '30.00', currency: 'BRL' } }, CONTEXT),
    );

    expect(error).toBeInstanceOf(ConflictError);
    expect((error as ConflictError).code).toBe('IDEMPOTENCY_KEY_CONFLICT');
    await expectLedgerConsistent(db.sql, wallet.id);
  });

  it('rejects the same provider transaction under another idempotency key', async () => {
    const wallet = await openWallet('100.00');
    const first = command(wallet);
    await submit.execute(first, CONTEXT);

    const error = await captureError(
      submit.execute({ ...first, idempotencyKey: 'another-key' }, CONTEXT),
    );

    expect((error as ConflictError).code).toBe('EXTERNAL_TRANSACTION_CONFLICT');
  });

  it('resolves a race on the same key across different wallets through the unique constraint', async () => {
    const [walletA, walletB] = await Promise.all([openWallet('100.00'), openWallet('100.00')]);
    const shared = command(walletA);
    // Different wallets: the row locks do not serialize them, both reach the INSERT.
    const results = await Promise.allSettled([
      submit.execute(shared, CONTEXT),
      submit.execute({ ...shared, walletId: walletB.id, playerId: walletB.playerId }, CONTEXT),
    ]);

    const fulfilled = results.filter((result) => result.status === 'fulfilled');
    const rejected = results.filter(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    );
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.reason).toBeInstanceOf(ConflictError);
    await expectLedgerConsistent(db.sql, walletA.id);
    await expectLedgerConsistent(db.sql, walletB.id);
  });
});

describe('inbox (queue entries)', () => {
  const inbox = () => ({ consumerName: 'wager-transactions-consumer', messageId: `msg-${uuid()}` });
  const inboxRows = async (messageId: string) =>
    (
      (await db.sql.unsafe('select 1 from inbox_messages where message_id = $1', [
        messageId,
      ])) as unknown[]
    ).length;

  it('deduplicates a redelivered message', async () => {
    const wallet = await openWallet('100.00');
    const message = inbox();
    const first = await submit.execute(command(wallet), CONTEXT, message);

    const redelivery = await submit
      .execute(
        command(wallet, { externalTransactionId: 'ignored-on-redelivery' }),
        CONTEXT,
        message,
      )
      .catch((error: unknown) => error);

    // Same messageId with another payload is a conflict; with the same payload it is a replay.
    expect((redelivery as ConflictError).code).toBe('MESSAGE_PAYLOAD_CONFLICT');
    expect(first.idempotentReplay).toBe(false);
    expect(await inboxRows(message.messageId)).toBe(1);
  });

  it('replays an identical redelivery without a second effect', async () => {
    const wallet = await openWallet('100.00');
    const message = inbox();
    const payload = command(wallet);
    const first = await submit.execute(payload, CONTEXT, message);

    const redelivery = await submit.execute(payload, CONTEXT, message);

    expect(redelivery).toEqual({ ...first, idempotentReplay: true });
    expect(await inboxRows(message.messageId)).toBe(1);
    await expectLedgerConsistent(db.sql, wallet.id);
  });

  it('records a new message carrying an already processed key as a replay', async () => {
    const wallet = await openWallet('100.00');
    const payload = command(wallet);
    await submit.execute(payload, CONTEXT, inbox());
    const second = inbox();

    const result = await submit.execute(payload, CONTEXT, second);

    expect(result.idempotentReplay).toBe(true);
    expect(await inboxRows(second.messageId)).toBe(1);
  });
});

describe('contract and infrastructure failures', () => {
  it('reserves the internal provider id', async () => {
    const wallet = await openWallet();

    const error = await captureError(
      submit.execute(command(wallet, { providerId: 'internal' }), CONTEXT),
    );

    expect(error).toBeInstanceOf(InvalidRequestError);
    expect((error as InvalidRequestError).code).toBe('RESERVED_PROVIDER');
  });

  it('refuses OPENING from outside', async () => {
    const wallet = await openWallet();

    const error = await captureError(
      submit.execute(command(wallet, { kind: Kind.Opening }), CONTEXT),
    );

    expect(error).toBeInstanceOf(InvalidWagerTransactionError);
    expect((error as InvalidWagerTransactionError).code).toBe('UNSUPPORTED_KIND');
  });

  it('answers not found for an unknown wallet without persisting anything', async () => {
    const wallet = await openWallet();
    const ghost = { ...wallet, id: uuid() };

    const error = await captureError(submit.execute(command(ghost), CONTEXT));

    expect(error).toBeInstanceOf(NotFoundError);
    expect((error as NotFoundError).code).toBe('WALLET_NOT_FOUND');
  });

  it('turns a lock wait beyond lock_timeout into a transient failure', async () => {
    const wallet = await openWallet('100.00');
    const impatientOrm = await MikroORM.init({
      ...buildMikroOrmConfig({ ...db.env, DATABASE_LOCK_TIMEOUT_MS: 300 }),
      migrations: { migrationsList: [] },
    });
    const impatient = new SubmitWagerTransaction(
      new MikroOrmUnitOfWork(impatientOrm),
      new UuidV7IdGenerator(),
      new SystemClock(),
      POLICY,
    );

    let error: unknown;
    try {
      await db.sql.begin(async (tx) => {
        await tx.unsafe('select 1 from wallets where id = $1 for update', [wallet.id]);
        error = await captureError(impatient.execute(command(wallet), CONTEXT));
      });
    } finally {
      await impatientOrm.close();
    }

    expect(error).toBeInstanceOf(TransientError);
    await expectLedgerConsistent(db.sql, wallet.id);
  });
});
