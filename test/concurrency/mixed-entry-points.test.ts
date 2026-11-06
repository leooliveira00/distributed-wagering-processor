import { GetQueueAttributesCommand } from '@aws-sdk/client-sqs';
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { expectLedgerConsistent } from '../integration/support/invariants';
import { createTestDatabase, type TestDatabase } from '../integration/support/test-database';
import { createQueuePair, type QueuePair } from '../integration/support/test-queue';
import { type Instance, spawnInstance, waitUntilLive } from './support/instances';
import { bet, openWallet, submit } from './support/wagering-client';

/**
 * README §8: "múltiplos workers recebem operações da mesma wallet". Two consumer processes and
 * one API process act on ONE wallet at the same time, every operation is delivered twice, and
 * the wallet can afford only 50 of the 60 bets. Only PostgreSQL is shared between processes.
 */
const OPERATIONS_PER_ENTRY_POINT = 30;
let db: TestDatabase;
let queues: QueuePair;
let api: Instance;
const consumers: Instance[] = [];

beforeAll(async () => {
  db = await createTestDatabase('concurrency_mixed');
  queues = await createQueuePair(db.env, 'concurrency-mixed', {
    visibilityTimeoutSeconds: 30,
    maxReceiveCount: 5,
  });
  const queueEnv = {
    SQS_WAGER_QUEUE_NAME: queues.main.name,
    SQS_WAGER_DLQ_NAME: queues.deadLetter.name,
    SQS_CONSUMER_WAIT_TIME_SECONDS: '1',
  };
  api = spawnInstance(db.env, { APP_ROLES: 'api' });
  consumers.push(spawnInstance(db.env, { APP_ROLES: 'consumer', ...queueEnv }));
  consumers.push(spawnInstance(db.env, { APP_ROLES: 'consumer', ...queueEnv }));
  await Promise.all(
    [api, ...consumers].map((instance) => waitUntilLive(instance.url, instance.process)),
  );
}, 90_000);

afterAll(async () => {
  const all = [api, ...consumers];
  for (const instance of all) instance.process.kill();
  await Promise.all(all.map((instance) => instance.process.exited));
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

describe('HTTP and queue consumers on the same wallet', () => {
  it('never overdraws and applies each operation once, whatever the entry point', async () => {
    const wallet = await openWallet(api.url, '100.00');
    const queued = Array.from({ length: OPERATIONS_PER_ENTRY_POINT }, () => bet(wallet, '2.00'));
    const viaHttp = Array.from({ length: OPERATIONS_PER_ENTRY_POINT }, () => bet(wallet, '2.00'));

    // Each queued operation is delivered twice (same messageId). A random MessageGroupId per
    // operation lets both consumers work on this wallet in parallel: only the row lock serializes.
    const enqueue = queued.flatMap((operation) => {
      const message = {
        messageId: `msg-${operation.externalTransactionId}`,
        type: 'WagerTransactionRequested',
        occurredAt: new Date().toISOString(),
        data: {
          ...operation,
          idempotencyKey: `${operation.providerId}:${operation.externalTransactionId}`,
        },
      };
      const groupId = crypto.randomUUID();
      return [queues.main.send(message, { groupId }), queues.main.send(message, { groupId })];
    });
    // Each HTTP operation is also sent twice, concurrently with the queue traffic.
    const posts = viaHttp.flatMap((operation) => [
      submit(api.url, operation),
      submit(api.url, operation),
    ]);
    await Promise.all([...enqueue, ...posts]);

    const deadline = Date.now() + 60_000;
    for (;;) {
      const rows: { count: number }[] = await db.sql.unsafe(
        `select count(*)::int as count from wager_transactions
          where wallet_id = $1 and kind = 'BET'`,
        [wallet.id],
      );
      if ((rows[0]?.count ?? 0) === OPERATIONS_PER_ENTRY_POINT * 2 && (await queueDepth()) === 0) {
        break;
      }
      if (Date.now() > deadline) throw new Error('operations were not all applied in time');
      await Bun.sleep(250);
    }

    const outcome: { status: string; count: number }[] = await db.sql.unsafe(
      `select status, count(*)::int as count from wager_transactions
        where wallet_id = $1 and kind = 'BET' group by status order by status`,
      [wallet.id],
    );
    const balance: { balance: string }[] = await db.sql.unsafe(
      'select balance::text as balance from wallets where id = $1',
      [wallet.id],
    );
    const debits: { count: number }[] = await db.sql.unsafe(
      `select count(*)::int as count from wallet_ledger_entries
        where wallet_id = $1 and direction = 'DEBIT'`,
      [wallet.id],
    );

    expect(outcome).toEqual([
      { status: 'PROCESSED', count: 50 },
      { status: 'REJECTED', count: 10 },
    ]);
    expect(balance[0]?.balance).toBe('0.00');
    expect(debits[0]?.count).toBe(50);
    expect(await queueDepth()).toBe(0);
    await expectLedgerConsistent(db.sql, wallet.id);
  }, 120_000);
});
