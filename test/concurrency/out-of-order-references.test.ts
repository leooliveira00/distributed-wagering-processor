import { GetQueueAttributesCommand } from '@aws-sdk/client-sqs';
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { CreateWallet } from '../../src/application/wallets/create-wallet';
import { type WalletView } from '../../src/application/wallets/wallet-views';
import { MikroOrmUnitOfWork } from '../../src/infrastructure/persistence/mikro-orm-unit-of-work';
import { SystemClock, UuidV7IdGenerator } from '../../src/infrastructure/system/system.adapters';
import { expectLedgerConsistent } from '../integration/support/invariants';
import { createTestDatabase, type TestDatabase } from '../integration/support/test-database';
import { createQueuePair, type QueuePair } from '../integration/support/test-queue';
import { type Instance, spawnInstance, waitUntilLive } from './support/instances';

/**
 * README §13 concurrency item 7, with real processes: ROLLBACK and REFUND delivered through the
 * queue BEFORE the transactions they reference. Messages of a wallet share one FIFO group, so the
 * reversals are guaranteed to be consumed first and to wait as PENDING_REFERENCE. One consumer
 * process and two pending-reference worker processes share only PostgreSQL.
 */
const WALLETS = 3;
let db: TestDatabase;
let queues: QueuePair;
const instances: Instance[] = [];

beforeAll(async () => {
  db = await createTestDatabase('concurrency_out_of_order');
  queues = await createQueuePair(db.env, 'concurrency-out-of-order', {
    visibilityTimeoutSeconds: 30,
    maxReceiveCount: 5,
  });
  const pendingEnv = {
    PENDING_REFERENCE_POLL_INTERVAL_MS: '100',
    // Fast enough for the orphan below to exhaust its attempts within the test.
    PENDING_REFERENCE_BASE_DELAY_MS: '100',
    PENDING_REFERENCE_MAX_DELAY_MS: '200',
    PENDING_REFERENCE_MAX_ATTEMPTS: '4',
  };
  instances.push(
    spawnInstance(db.env, {
      APP_ROLES: 'consumer',
      SQS_WAGER_QUEUE_NAME: queues.main.name,
      SQS_WAGER_DLQ_NAME: queues.deadLetter.name,
      SQS_CONSUMER_WAIT_TIME_SECONDS: '1',
      ...pendingEnv,
    }),
    spawnInstance(db.env, { APP_ROLES: 'pending', ...pendingEnv }),
    spawnInstance(db.env, { APP_ROLES: 'pending', ...pendingEnv }),
  );
  await Promise.all(instances.map((instance) => waitUntilLive(instance.url, instance.process)));
}, 90_000);

afterAll(async () => {
  for (const instance of instances) instance.process.kill();
  await Promise.all(instances.map((instance) => instance.process.exited));
  await queues.close();
  await db.close();
});

async function queueDepth(): Promise<number> {
  const { Attributes } = await queues.main.sqs.send(
    new GetQueueAttributesCommand({
      QueueUrl: queues.main.url,
      AttributeNames: ['ApproximateNumberOfMessages', 'ApproximateNumberOfMessagesNotVisible'],
    }),
  );
  return (
    Number(Attributes?.ApproximateNumberOfMessages ?? '0') +
    Number(Attributes?.ApproximateNumberOfMessagesNotVisible ?? '0')
  );
}

interface Operation {
  externalTransactionId: string;
  kind: 'BET' | 'WIN' | 'REFUND' | 'ROLLBACK';
  amount: string;
  referenceExternalTransactionId?: string;
}

function message(wallet: WalletView, operation: Operation) {
  const providerId = 'provider-a';
  const externalTransactionId = `${wallet.id}:${operation.externalTransactionId}`;
  return {
    messageId: `msg-${externalTransactionId}`,
    type: 'WagerTransactionRequested',
    occurredAt: new Date().toISOString(),
    data: {
      providerId,
      externalTransactionId,
      idempotencyKey: `${providerId}:${externalTransactionId}`,
      playerId: wallet.playerId,
      walletId: wallet.id,
      roundId: 'round-1',
      gameId: 'fortune-chimp',
      kind: operation.kind,
      money: { amount: operation.amount, currency: 'BRL' },
      ...(operation.referenceExternalTransactionId
        ? {
            referenceExternalTransactionId: `${wallet.id}:${operation.referenceExternalTransactionId}`,
          }
        : {}),
    },
  };
}

/** Every reversal first, then the transactions they reference (README §13.7). */
const OUT_OF_ORDER: Operation[] = [
  {
    externalTransactionId: 'refund-1',
    kind: 'REFUND',
    amount: '25.00',
    referenceExternalTransactionId: 'bet-1',
  },
  {
    externalTransactionId: 'rollback-2',
    kind: 'ROLLBACK',
    amount: '25.00',
    referenceExternalTransactionId: 'bet-2',
  },
  // A chain: ROLLBACK of a WIN that itself references a BET not sent yet.
  {
    externalTransactionId: 'rollback-3',
    kind: 'ROLLBACK',
    amount: '40.00',
    referenceExternalTransactionId: 'win-3',
  },
  {
    externalTransactionId: 'win-3',
    kind: 'WIN',
    amount: '40.00',
    referenceExternalTransactionId: 'bet-3',
  },
  // Never followed by its reference: must end REJECTED / REFERENCE_NOT_FOUND.
  {
    externalTransactionId: 'refund-orphan',
    kind: 'REFUND',
    amount: '10.00',
    referenceExternalTransactionId: 'never-sent',
  },
  { externalTransactionId: 'bet-1', kind: 'BET', amount: '25.00' },
  { externalTransactionId: 'bet-2', kind: 'BET', amount: '25.00' },
  { externalTransactionId: 'bet-3', kind: 'BET', amount: '25.00' },
];

describe('references delivered after their reversals (real processes)', () => {
  it('resolves every waiting reversal and rejects the orphan, with consistent ledgers', async () => {
    const createWallet = new CreateWallet(
      new MikroOrmUnitOfWork(db.orm),
      new UuidV7IdGenerator(),
      new SystemClock(),
    );
    const wallets = await Promise.all(
      Array.from({ length: WALLETS }, () =>
        createWallet.execute(
          { playerId: crypto.randomUUID(), initialBalance: { amount: '100.00', currency: 'BRL' } },
          { correlationId: 'corr-out-of-order' },
        ),
      ),
    );

    // Sequential sends per wallet: FIFO order within the group is the delivery order.
    await Promise.all(
      wallets.map(async (wallet) => {
        for (const operation of OUT_OF_ORDER) {
          await queues.main.send(message(wallet, operation), { groupId: wallet.id });
        }
      }),
    );

    const walletIds = wallets.map((wallet) => wallet.id);
    const deadline = Date.now() + 60_000;
    for (;;) {
      const rows: { settled: number }[] = await db.sql.unsafe(
        `select count(*)::int as settled from wager_transactions
          where wallet_id = any($1::uuid[]) and kind <> 'OPENING'
            and status in ('PROCESSED', 'REJECTED')`,
        [walletIds],
      );
      if (rows[0]?.settled === WALLETS * OUT_OF_ORDER.length && (await queueDepth()) === 0) break;
      if (Date.now() > deadline) throw new Error('transactions did not settle in time');
      await Bun.sleep(250);
    }

    for (const wallet of wallets) {
      const rows: { id: string; status: string; failure_code: string | null }[] =
        await db.sql.unsafe(
          `select split_part(external_transaction_id, ':', 2) as id, status, failure_code
             from wager_transactions where wallet_id = $1 and kind <> 'OPENING'
            order by 1`,
          [wallet.id],
        );
      expect(rows).toEqual([
        { id: 'bet-1', status: 'PROCESSED', failure_code: null },
        { id: 'bet-2', status: 'PROCESSED', failure_code: null },
        { id: 'bet-3', status: 'PROCESSED', failure_code: null },
        { id: 'refund-1', status: 'PROCESSED', failure_code: null },
        { id: 'refund-orphan', status: 'REJECTED', failure_code: 'REFERENCE_NOT_FOUND' },
        { id: 'rollback-2', status: 'PROCESSED', failure_code: null },
        { id: 'rollback-3', status: 'PROCESSED', failure_code: null },
        { id: 'win-3', status: 'PROCESSED', failure_code: null },
      ]);

      // Proof the order really was inverted: every reversal (and the WIN) waited first.
      const waited: { count: number }[] = await db.sql.unsafe(
        `select count(*)::int as count from outbox_messages o
           join wager_transactions t on t.id::text = o.aggregate_id
          where t.wallet_id = $1 and o.event_type = 'WagerTransactionPendingReference'`,
        [wallet.id],
      );
      expect(waited[0]?.count).toBe(5);

      // 100 - 25 + 25 (refund) - 25 + 25 (rollback) - 25 + 40 (win) - 40 (rollback of win).
      const balance: { balance: string }[] = await db.sql.unsafe(
        'select balance::text as balance from wallets where id = $1',
        [wallet.id],
      );
      expect(balance[0]?.balance).toBe('75.00');
      await expectLedgerConsistent(db.sql, wallet.id);
    }
    expect(await queueDepth()).toBe(0);
  }, 120_000);
});
