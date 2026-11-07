import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { SubmitWagerTransaction } from '../../../src/application/wagering/submit-wager-transaction';
import { CreateWallet } from '../../../src/application/wallets/create-wallet';
import { WagerTransactionKind } from '../../../src/domain/wagering/wager-transaction-kind';
import { type AppRole, type Env } from '../../../src/infrastructure/config/env';
import { createSqsClient } from '../../../src/infrastructure/messaging/sqs/sqs-client';
import { OperationalGauges } from '../../../src/infrastructure/observability/operational-gauges';
import { PrometheusMetrics } from '../../../src/infrastructure/observability/prometheus-metrics';
import { MikroOrmUnitOfWork } from '../../../src/infrastructure/persistence/mikro-orm-unit-of-work';
import { SystemClock, UuidV7IdGenerator } from '../../../src/infrastructure/system/system.adapters';
import { uuid } from '../support/domain-fixtures';
import { sampleValue } from '../support/prometheus-text';
import { createTestDatabase, type TestDatabase } from '../support/test-database';
import { RecordingLogger } from '../support/test-loggers';
import { createQueuePair, type QueuePair } from '../support/test-queue';

/**
 * Gauges of shared state read at scrape time (README §12: outbox lag, messages in the DLQ),
 * against the real PostgreSQL and SQS emulator.
 */
let db: TestDatabase;
let queues: QueuePair;

beforeAll(async () => {
  db = await createTestDatabase('operational_gauges');
  queues = await createQueuePair(db.env, 'operational-gauges', {
    visibilityTimeoutSeconds: 30,
    maxReceiveCount: 5,
  });
});

afterAll(async () => {
  await queues.close();
  await db.close();
});

/** A fresh registry per scrape, so the short sampling cache never hides a change. */
async function scrape(
  roles: AppRole[],
  overrides: Partial<Env> = {},
  times = 1,
): Promise<{ text: string; logger: RecordingLogger }> {
  const env: Env = {
    ...db.env,
    APP_ROLES: roles,
    SQS_WAGER_QUEUE_NAME: queues.main.name,
    SQS_WAGER_DLQ_NAME: queues.deadLetter.name,
    ...overrides,
  };
  const metrics = new PrometheusMetrics();
  const logger = new RecordingLogger();
  const sqs = createSqsClient(env);
  new OperationalGauges(metrics, db.orm, sqs, env, logger).onModuleInit();
  let text = '';
  for (let scrapeIndex = 0; scrapeIndex < times; scrapeIndex++) {
    text = await metrics.registry.metrics();
    if (scrapeIndex < times - 1) await Bun.sleep(1_100); // past the sampling cache
  }
  sqs.destroy();
  return { text, logger };
}

async function unpublishedEvents(): Promise<number> {
  const rows: { count: number }[] = await db.sql.unsafe(
    'select count(*)::int as count from outbox_messages where published_at is null',
  );
  return rows[0]?.count ?? -1;
}

describe('outbox lag gauges (role outbox)', () => {
  it('report pending events and the age of the oldest one', async () => {
    const unitOfWork = new MikroOrmUnitOfWork(db.orm);
    const ids = new UuidV7IdGenerator();
    const clock = new SystemClock();
    const wallet = await new CreateWallet(unitOfWork, ids, clock).execute(
      { playerId: uuid(), initialBalance: { amount: '100.00', currency: 'BRL' } },
      { correlationId: 'corr-gauges' },
    );
    const submit = new SubmitWagerTransaction(
      unitOfWork,
      ids,
      clock,
      { backoff: { baseMs: 1_000, capMs: 60_000 }, maxAttempts: 10 },
      new PrometheusMetrics(),
    );
    await submit.execute(
      {
        providerId: 'provider-a',
        externalTransactionId: 'tx-gauge-1',
        idempotencyKey: 'provider-a:tx-gauge-1',
        playerId: wallet.playerId,
        walletId: wallet.id,
        roundId: 'round-1',
        gameId: 'fortune-chimp',
        kind: WagerTransactionKind.Bet,
        money: { amount: '25.00', currency: 'BRL' },
      },
      { correlationId: 'corr-gauges' },
    );
    await Bun.sleep(1_100); // the oldest event is now at least a second old

    const { text } = await scrape(['outbox']);
    expect(sampleValue(text, 'outbox_pending_events')).toBe(await unpublishedEvents());
    expect(sampleValue(text, 'outbox_pending_events')).toBeGreaterThanOrEqual(2);
    expect(sampleValue(text, 'outbox_oldest_pending_age_seconds')).toBeGreaterThanOrEqual(1);

    await db.sql.unsafe(
      'update outbox_messages set published_at = now() where published_at is null',
    );
    const drained = (await scrape(['outbox'])).text;
    expect(sampleValue(drained, 'outbox_pending_events')).toBe(0);
    expect(sampleValue(drained, 'outbox_oldest_pending_age_seconds')).toBe(0);
  });
});

describe('queue depth gauges (role consumer)', () => {
  it('report messages in the wager queue and in its dead-letter queue', async () => {
    await queues.main.send({ n: 1 }, { groupId: 'g-1' });
    await queues.main.send({ n: 2 }, { groupId: 'g-2' });
    await queues.deadLetter.send({ n: 3 }, { groupId: 'g-3' });

    const { text } = await scrape(['consumer']);
    expect(sampleValue(text, 'sqs_queue_messages', { queue: 'main' })).toBe(2);
    expect(sampleValue(text, 'sqs_queue_messages', { queue: 'dead_letter' })).toBe(1);
  });

  it('export no stale value when the read fails, count and log it, and still answer', async () => {
    // Two scrapes, two failed reads: the counter shows the first one, the second shows next time.
    const { text, logger } = await scrape(
      ['consumer'],
      { SQS_WAGER_QUEUE_NAME: 'does-not-exist.fifo' },
      2,
    );
    expect(sampleValue(text, 'sqs_queue_messages', { queue: 'main' })).toBeUndefined();
    expect(sampleValue(text, 'metrics_collection_failures_total', { collector: 'sqs' })).toBe(1);
    expect(text).toContain('process_resident_memory_bytes'); // the rest of the scrape is intact
    expect(logger.warnings.map((line) => line.fields.collector)).toEqual(['sqs', 'sqs']);
  });
});

describe('role gating', () => {
  it('registers shared-state gauges only on the role responsible for them', async () => {
    const { text } = await scrape(['api', 'pending']);
    expect(text).not.toContain('outbox_pending_events');
    expect(text).not.toContain('sqs_queue_messages');
  });
});
