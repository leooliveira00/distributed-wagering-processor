import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { SubmitWagerTransaction } from '../../src/application/wagering/submit-wager-transaction';
import { CreateWallet } from '../../src/application/wallets/create-wallet';
import { WagerTransactionKind } from '../../src/domain/wagering/wager-transaction-kind';
import { MikroOrmUnitOfWork } from '../../src/infrastructure/persistence/mikro-orm-unit-of-work';
import { SystemClock, UuidV7IdGenerator } from '../../src/infrastructure/system/system.adapters';
import { type Instance, spawnInstance, waitUntilLive } from '../concurrency/support/instances';
import { createTestDatabase, type TestDatabase } from '../integration/support/test-database';
import { createTestQueue, type TestQueue } from '../integration/support/test-queue';

/**
 * README §11 with real processes:
 *   1. PostgreSQL commits the transaction (events are in the outbox);
 *   2. the process dies before publishing (SIGKILL via fault injection);
 *   3. another instance takes over;
 *   4. the events are published;
 *   5. a duplicate publication is still safe.
 */
const LEASE_MS = '2000';

let db: TestDatabase;
let queue: TestQueue;
const running: Instance[] = [];

beforeAll(async () => {
  db = await createTestDatabase('resilience_outbox');
  queue = await createTestQueue(db.env, 'resilience-outbox');
});

afterAll(async () => {
  for (const instance of running) instance.process.kill();
  await Promise.all(running.map((instance) => instance.process.exited));
  await queue.close();
  await db.close();
});

/** Commits a wallet plus `bets` BETs through the real use cases; returns all outbox event ids. */
async function commitEvents(bets: number): Promise<string[]> {
  const unitOfWork = new MikroOrmUnitOfWork(db.orm);
  const ids = new UuidV7IdGenerator();
  const clock = new SystemClock();
  const context = { correlationId: 'corr-resilience' };
  const wallet = await new CreateWallet(unitOfWork, ids, clock).execute(
    { playerId: crypto.randomUUID(), initialBalance: { amount: '100.00', currency: 'BRL' } },
    context,
  );
  const submit = new SubmitWagerTransaction(unitOfWork, ids, clock, {
    backoff: { baseMs: 1_000, capMs: 60_000 },
    maxAttempts: 10,
  });
  for (let index = 0; index < bets; index++) {
    const externalTransactionId = `tx-${crypto.randomUUID()}`;
    await submit.execute(
      {
        providerId: 'provider-a',
        externalTransactionId,
        idempotencyKey: `provider-a:${externalTransactionId}`,
        playerId: wallet.playerId,
        walletId: wallet.id,
        roundId: 'round-1',
        gameId: 'fortune-chimp',
        kind: WagerTransactionKind.Bet,
        money: { amount: '1.00', currency: 'BRL' },
      },
      context,
    );
  }
  const rows: { id: string }[] = await db.sql.unsafe(
    'select id::text from outbox_messages where published_at is null',
  );
  return rows.map((row) => row.id);
}

const outboxInstance = (overrides: Record<string, string> = {}) => {
  const instance = spawnInstance(db.env, {
    APP_ROLES: 'outbox',
    SQS_EVENTS_QUEUE_NAME: queue.name,
    OUTBOX_LEASE_MS: LEASE_MS,
    OUTBOX_POLL_INTERVAL_MS: '100',
    ...overrides,
  });
  running.push(instance);
  return instance;
};

async function unpublished(): Promise<number> {
  const rows: { count: number }[] = await db.sql.unsafe(
    'select count(*)::int as count from outbox_messages where published_at is null',
  );
  return rows[0]?.count ?? -1;
}

async function waitUntilAllPublished(timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while ((await unpublished()) > 0) {
    if (Date.now() > deadline) throw new Error('outbox was not drained in time');
    await Bun.sleep(100);
  }
}

describe('outbox recovery with real processes', () => {
  it('a publisher killed right after claiming is replaced by another instance', async () => {
    const eventIds = await commitEvents(3);

    const victim = outboxInstance({ FAULT_INJECTION: 'outbox:after-claim' });
    const exitCode = await victim.process.exited;

    expect(exitCode).not.toBe(0); // died abruptly, no graceful shutdown
    expect(await unpublished()).toBe(eventIds.length); // nothing lost, nothing published
    const leased: { count: number }[] = await db.sql.unsafe(
      'select count(*)::int as count from outbox_messages where locked_until > now()',
    );
    expect(leased[0]?.count).toBe(eventIds.length); // its lease still holds the batch

    const survivor = outboxInstance();
    await waitUntilLive(survivor.url, survivor.process);
    await waitUntilAllPublished(15_000);
    const received = await queue.drain();

    expect(received.map((message) => message.body.eventId as string).sort()).toEqual(
      [...eventIds].sort(),
    );
    survivor.process.kill();
    await survivor.process.exited;
  }, 60_000);

  it('a publisher killed after sending but before marking causes only a safe duplicate', async () => {
    const eventIds = await commitEvents(2);

    const victim = outboxInstance({ FAULT_INJECTION: 'outbox:after-publish' });
    expect(await victim.process.exited).not.toBe(0);
    expect(await unpublished()).toBe(eventIds.length); // sent one, marked none

    const survivor = outboxInstance();
    await waitUntilLive(survivor.url, survivor.process);
    await waitUntilAllPublished(15_000);
    const received = await queue.drain();

    // The first event was sent twice with the same deduplication id: delivered once.
    const receivedIds = received.map((message) => message.body.eventId as string);
    expect(receivedIds).toHaveLength(eventIds.length);
    expect(new Set(receivedIds)).toEqual(new Set(eventIds));
    survivor.process.kill();
    await survivor.process.exited;
  }, 60_000);
});
