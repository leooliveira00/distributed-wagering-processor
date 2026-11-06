import { afterEach, describe, expect, it } from 'bun:test';
import {
  type PublishOutboxOptions,
  PublishOutbox,
} from '../../../src/application/outbox/publish-outbox';
import { type FaultInjector, type FaultPoint } from '../../../src/application/ports/fault-injector';
import { type MessagePublisher } from '../../../src/application/ports/message-publisher';
import { SubmitWagerTransaction } from '../../../src/application/wagering/submit-wager-transaction';
import { WagerTransactionKind } from '../../../src/domain/wagering/wager-transaction-kind';
import { CreateWallet } from '../../../src/application/wallets/create-wallet';
import { type OutboxMessage } from '../../../src/domain/messaging/outbox-message';
import { SqsMessagePublisher } from '../../../src/infrastructure/messaging/sqs/sqs-message-publisher';
import { PrometheusMetrics } from '../../../src/infrastructure/observability/prometheus-metrics';
import { MikroOrmUnitOfWork } from '../../../src/infrastructure/persistence/mikro-orm-unit-of-work';
import { SystemClock, UuidV7IdGenerator } from '../../../src/infrastructure/system/system.adapters';
import { createTestDatabase, type TestDatabase } from '../support/test-database';
import { createTestQueue, type TestQueue } from '../support/test-queue';
import { silentLogger } from '../support/test-loggers';

const noFaults: FaultInjector = { trigger: () => undefined };
const LEASE_MS = 500;
const OPTIONS: PublishOutboxOptions = {
  batchSize: 50,
  leaseMs: LEASE_MS,
  retry: { baseMs: 200, capMs: 1_000 },
};

class SimulatedCrash extends Error {}

/** Throws at a chosen point, aborting the pass exactly like a process death would. */
const crashAt = (point: FaultPoint): FaultInjector => ({
  trigger: (reached) => {
    if (reached === point) throw new SimulatedCrash(`crash at ${point}`);
  },
});

interface Fixture {
  db: TestDatabase;
  queue: TestQueue;
  publisher: MessagePublisher;
  metrics: PrometheusMetrics;
  newPublisher(overrides?: {
    publisher?: MessagePublisher;
    faults?: FaultInjector;
    options?: Partial<PublishOutboxOptions>;
  }): PublishOutbox;
  /** Creates `wallets` wallets with `betsPerWallet` BETs each; returns the outbox event ids. */
  seed(wallets: number, betsPerWallet: number): Promise<string[]>;
  outboxState(): Promise<{ id: string; published: boolean; leased: boolean; attempts: number }[]>;
}

const fixtures: Fixture[] = [];

afterEach(async () => {
  for (const fixture of fixtures.splice(0)) {
    await fixture.queue.close();
    await fixture.db.close();
  }
});

/** Fresh database and queue per test: leases and pending rows never leak between tests. */
async function setup(name: string): Promise<Fixture> {
  const db = await createTestDatabase(`outbox_${name}`);
  const queue = await createTestQueue(db.env, name);
  const unitOfWork = new MikroOrmUnitOfWork(db.orm);
  const ids = new UuidV7IdGenerator();
  const clock = new SystemClock();
  const metrics = new PrometheusMetrics();
  const publisher = new SqsMessagePublisher(queue.sqs, queue.name);
  const createWallet = new CreateWallet(unitOfWork, ids, clock);
  const submit = new SubmitWagerTransaction(unitOfWork, ids, clock, {
    backoff: { baseMs: 1_000, capMs: 60_000 },
    maxAttempts: 10,
  });
  const context = { correlationId: 'corr-outbox' };

  const fixture: Fixture = {
    db,
    queue,
    publisher,
    metrics,
    newPublisher: (overrides = {}) =>
      new PublishOutbox(
        unitOfWork,
        overrides.publisher ?? publisher,
        clock,
        metrics,
        silentLogger,
        overrides.faults ?? noFaults,
        { ...OPTIONS, ...overrides.options },
      ),
    async seed(wallets, betsPerWallet) {
      for (let w = 0; w < wallets; w++) {
        const wallet = await createWallet.execute(
          { playerId: crypto.randomUUID(), initialBalance: { amount: '1000.00', currency: 'BRL' } },
          context,
        );
        for (let b = 0; b < betsPerWallet; b++) {
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
      }
      const rows: { id: string }[] = await db.sql.unsafe('select id from outbox_messages');
      return rows.map((row) => row.id);
    },
    async outboxState() {
      return db.sql.unsafe(
        `select id::text, published_at is not null as published,
                coalesce(locked_until > now(), false) as leased, attempts
           from outbox_messages order by occurred_at, id`,
      );
    },
  };
  fixtures.push(fixture);
  return fixture;
}

const eventIdOf = (body: Record<string, unknown>) => body.eventId as string;

describe('PublishOutbox', () => {
  it('publishes every pending event once, grouped by wallet and deduplicated by event id', async () => {
    const f = await setup('publish');
    const eventIds = await f.seed(1, 3); // opening: 2 events, each BET: 2 events

    const result = await f.newPublisher().runOnce();
    const received = await f.queue.drain();

    expect(eventIds).toHaveLength(8);
    expect(result).toEqual({ claimed: 8, published: 8, failed: 0 });
    expect(received.map((message) => eventIdOf(message.body)).sort()).toEqual([...eventIds].sort());
    for (const message of received) {
      expect(message.deduplicationId).toBe(eventIdOf(message.body));
      expect(message.groupId).toBe((message.body.data as { walletId: string }).walletId);
      expect(message.eventType).toBe(message.body.eventType as string);
      expect(message.body).toMatchObject({ correlationId: 'corr-outbox', version: 1 });
    }
    expect((await f.outboxState()).every((row) => row.published && !row.leased)).toBe(true);
    expect((await f.newPublisher().runOnce()).claimed).toBe(0);
  }, 30_000);

  it('splits the work between concurrent publishers without publishing anything twice', async () => {
    const f = await setup('concurrent');
    const eventIds = await f.seed(5, 4); // 5 * (2 + 4 * 2) = 50 events

    const publishers = [1, 2, 3].map(() => f.newPublisher({ options: { batchSize: 5 } }));
    const totals = await Promise.all(
      publishers.map(async (publisher) => {
        let published = 0;
        for (;;) {
          const result = await publisher.runOnce();
          if (result.claimed === 0) return published;
          published += result.published;
        }
      }),
    );
    const received = await f.queue.drain();

    expect(totals.reduce((sum, value) => sum + value, 0)).toBe(eventIds.length);
    expect(totals.filter((value) => value > 0).length).toBeGreaterThan(1); // work was really shared
    expect(received).toHaveLength(eventIds.length);
    expect(new Set(received.map((message) => eventIdOf(message.body))).size).toBe(eventIds.length);
  }, 60_000);

  it('lets another publisher take over once a crashed publisher lease expires', async () => {
    const f = await setup('lease');
    const eventIds = await f.seed(1, 2);

    const crashed = await f
      .newPublisher({ faults: crashAt('outbox:after-claim') })
      .runOnce()
      .catch((error: unknown) => error);
    const stateAfterCrash = await f.outboxState();
    const whileLeased = await f.newPublisher().runOnce();
    await Bun.sleep(LEASE_MS + 200);
    const afterExpiry = await f.newPublisher().runOnce();
    const received = await f.queue.drain();

    expect(crashed).toBeInstanceOf(SimulatedCrash);
    expect(stateAfterCrash.every((row) => row.leased && !row.published)).toBe(true);
    expect(whileLeased.claimed).toBe(0);
    expect(afterExpiry.published).toBe(eventIds.length);
    expect(received).toHaveLength(eventIds.length);
  }, 30_000);

  it('keeps a duplicate publication safe after a crash between publish and mark', async () => {
    const f = await setup('duplicate');
    const eventIds = await f.seed(1, 2);

    // Publishes the first event, then "dies" before marking anything as published.
    const crashed = await f
      .newPublisher({ faults: crashAt('outbox:after-publish') })
      .runOnce()
      .catch((error: unknown) => error);
    await Bun.sleep(LEASE_MS + 200);
    const recovery = await f.newPublisher().runOnce();
    const received = await f.queue.drain();

    expect(crashed).toBeInstanceOf(SimulatedCrash);
    expect(recovery.published).toBe(eventIds.length); // the first event was sent a second time
    // Same MessageDeduplicationId: the broker drops the second copy; consumers could too.
    expect(received).toHaveLength(eventIds.length);
    expect(new Set(received.map((message) => eventIdOf(message.body))).size).toBe(eventIds.length);
  }, 30_000);

  it('retries failed publications with backoff and never drops them', async () => {
    const f = await setup('retry');
    const eventIds = await f.seed(1, 0); // the 2 opening events
    let failuresLeft = eventIds.length * 2; // every event fails twice
    const flaky: MessagePublisher = {
      publish(message: OutboxMessage) {
        if (failuresLeft > 0) {
          failuresLeft--;
          return Promise.reject(new Error('broker unavailable'));
        }
        return f.publisher.publish(message);
      },
    };
    const publisher = f.newPublisher({ publisher: flaky });

    const first = await publisher.runOnce();
    const afterFirst = await f.outboxState();
    const notYetDue = await publisher.runOnce();
    await Bun.sleep(350); // past the first backoff (200 ms)
    const second = await publisher.runOnce();
    await Bun.sleep(600); // past the second backoff (400 ms)
    const third = await publisher.runOnce();
    const received = await f.queue.drain();

    expect(first).toEqual({ claimed: 2, published: 0, failed: 2 });
    expect(afterFirst.every((row) => row.attempts === 1 && !row.leased && !row.published)).toBe(
      true,
    );
    expect(notYetDue.claimed).toBe(0);
    expect(second.failed).toBe(2);
    expect(third).toEqual({ claimed: 2, published: 2, failed: 0 });
    expect(received).toHaveLength(2);
    expect(
      await f.metrics.counterValue('outbox_publish_failures_total', {
        eventType: 'WalletBalanceChanged',
      }),
    ).toBe(2);
  }, 30_000);
});
