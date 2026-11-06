import { GetQueueAttributesCommand } from '@aws-sdk/client-sqs';
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { CreateWallet } from '../../src/application/wallets/create-wallet';
import { MikroOrmUnitOfWork } from '../../src/infrastructure/persistence/mikro-orm-unit-of-work';
import { SystemClock, UuidV7IdGenerator } from '../../src/infrastructure/system/system.adapters';
import { type Instance, spawnInstance, waitUntilLive } from '../concurrency/support/instances';
import { expectLedgerConsistent } from '../integration/support/invariants';
import { createTestDatabase, type TestDatabase } from '../integration/support/test-database';
import { createQueuePair, type QueuePair, type TestQueue } from '../integration/support/test-queue';

/**
 * README §13 concurrency item 5, with real processes: a consumer dies AFTER the commit and
 * BEFORE the ack. The message comes back after its visibility timeout, another instance receives
 * it, and the persistent inbox turns it into a replay: exactly one financial effect.
 */
let db: TestDatabase;
let queues: QueuePair;
const running: Instance[] = [];

beforeAll(async () => {
  db = await createTestDatabase('resilience_consumer');
  queues = await createQueuePair(db.env, 'resilience-consumer', {
    visibilityTimeoutSeconds: 2,
    maxReceiveCount: 5,
  });
});

afterAll(async () => {
  for (const instance of running) instance.process.kill();
  await Promise.all(running.map((instance) => instance.process.exited));
  await queues.close();
  await db.close();
});

const consumerInstance = (overrides: Record<string, string> = {}) => {
  const instance = spawnInstance(db.env, {
    APP_ROLES: 'consumer',
    SQS_WAGER_QUEUE_NAME: queues.main.name,
    SQS_WAGER_DLQ_NAME: queues.deadLetter.name,
    SQS_CONSUMER_WAIT_TIME_SECONDS: '1',
    ...overrides,
  });
  running.push(instance);
  return instance;
};

async function depth(queue: TestQueue): Promise<number> {
  const { Attributes } = await queue.sqs.send(
    new GetQueueAttributesCommand({
      QueueUrl: queue.url,
      AttributeNames: ['ApproximateNumberOfMessages', 'ApproximateNumberOfMessagesNotVisible'],
    }),
  );
  return (
    Number(Attributes?.ApproximateNumberOfMessages ?? '0') +
    Number(Attributes?.ApproximateNumberOfMessagesNotVisible ?? '0')
  );
}

async function count(sql: string, params: unknown[]): Promise<number> {
  const rows: { count: number }[] = await db.sql.unsafe(sql, params);
  return rows[0]?.count ?? -1;
}

describe('consumer crash between commit and ack (real processes)', () => {
  it('redelivers the message and the inbox prevents a second debit', async () => {
    const wallet = await new CreateWallet(
      new MikroOrmUnitOfWork(db.orm),
      new UuidV7IdGenerator(),
      new SystemClock(),
    ).execute(
      { playerId: crypto.randomUUID(), initialBalance: { amount: '100.00', currency: 'BRL' } },
      { correlationId: 'corr-resilience' },
    );
    const messageId = `msg-${crypto.randomUUID()}`;
    await queues.main.send(
      {
        messageId,
        type: 'WagerTransactionRequested',
        occurredAt: new Date().toISOString(),
        data: {
          providerId: 'provider-a',
          externalTransactionId: 'tx-crash-1',
          idempotencyKey: 'provider-a:tx-crash-1',
          playerId: wallet.playerId,
          walletId: wallet.id,
          roundId: 'round-1',
          gameId: 'fortune-chimp',
          kind: 'BET',
          money: { amount: '25.00', currency: 'BRL' },
        },
      },
      { groupId: wallet.id },
    );
    const debits = () =>
      count(
        `select count(*)::int as count from wallet_ledger_entries
          where wallet_id = $1 and direction = 'DEBIT'`,
        [wallet.id],
      );

    // 1. Commit happens, then SIGKILL before the DeleteMessage.
    const victim = consumerInstance({ FAULT_INJECTION: 'consumer:after-commit' });
    expect(await victim.process.exited).not.toBe(0);
    expect(await debits()).toBe(1); // committed
    expect(await depth(queues.main)).toBe(1); // but never acknowledged

    // 2. Another instance takes the redelivered message.
    const survivor = consumerInstance();
    await waitUntilLive(survivor.url, survivor.process);
    const deadline = Date.now() + 20_000;
    while ((await depth(queues.main)) > 0) {
      if (Date.now() > deadline) throw new Error('message was not consumed again in time');
      await Bun.sleep(200);
    }

    // 3. Exactly one effect.
    expect(await debits()).toBe(1);
    expect(
      await count(
        `select count(*)::int as count from wager_transactions
          where wallet_id = $1 and kind = 'BET'`,
        [wallet.id],
      ),
    ).toBe(1);
    expect(
      await count('select count(*)::int as count from inbox_messages where message_id = $1', [
        messageId,
      ]),
    ).toBe(1);
    expect(await depth(queues.deadLetter)).toBe(0);
    await expectLedgerConsistent(db.sql, wallet.id);

    survivor.process.kill();
    await survivor.process.exited;
  }, 60_000);
});
