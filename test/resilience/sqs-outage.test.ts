import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { type WalletView } from '../../src/application/wallets/wallet-views';
import { type Instance, spawnInstance, waitUntilLive } from '../concurrency/support/instances';
import { bet, openWallet } from '../concurrency/support/wagering-client';
import { expectLedgerConsistent } from '../integration/support/invariants';
import { createTestDatabase, type TestDatabase } from '../integration/support/test-database';
import {
  createQueuePair,
  createTestQueue,
  type QueuePair,
  type TestQueue,
} from '../integration/support/test-queue';
import { eventually, queueDepth } from './support/eventually';
import { type FaultMode, type FaultProxy, startFaultProxy } from './support/fault-proxy';
import {
  countRows,
  enqueueOperation,
  expectAppliedOnce,
  expectReconciled,
  postOperation,
  statusOf,
  unpublishedEvents,
} from './support/operations';

/**
 * README §3: "... SQS pode ficar temporariamente indisponível". A real process (every role)
 * reaches SQS through a TCP proxy the test controls; the provider (this test) still reaches the
 * broker directly. The synchronous path depends only on PostgreSQL, so the API keeps accepting
 * bets; events wait in the outbox and queued operations wait in the queue, with nothing lost.
 */
const OUTAGE_MS = 5_000;
/** The API must answer as usual: SQS is not on the synchronous path. */
const API_LATENCY_MS = 2_000;

let db: TestDatabase;
let queues: QueuePair;
let events: TestQueue;
let proxy: FaultProxy;
let instance: Instance;
let wallet: WalletView;

beforeAll(async () => {
  db = await createTestDatabase('resilience_sqs_outage');
  queues = await createQueuePair(db.env, 'resilience-sqs-outage', {
    visibilityTimeoutSeconds: 5,
    maxReceiveCount: 10,
  });
  events = await createTestQueue(db.env, 'resilience-sqs-outage-events');
  const broker = new URL(db.env.AWS_ENDPOINT_URL ?? 'http://localhost:4566');
  proxy = startFaultProxy({ host: broker.hostname, port: Number(broker.port) });
  instance = spawnInstance(db.env, {
    APP_ROLES: 'api,consumer,outbox,pending',
    AWS_ENDPOINT_URL: `http://127.0.0.1:${String(proxy.port)}`,
    SQS_WAGER_QUEUE_NAME: queues.main.name,
    SQS_WAGER_DLQ_NAME: queues.deadLetter.name,
    SQS_EVENTS_QUEUE_NAME: events.name,
    SQS_CONSUMER_WAIT_TIME_SECONDS: '1',
    OUTBOX_POLL_INTERVAL_MS: '200',
    OUTBOX_RETRY_BASE_DELAY_MS: '200',
    OUTBOX_RETRY_MAX_DELAY_MS: '1000',
    // Short bounds keep the suite fast; production defaults are 3s / 25s.
    SQS_CONNECT_TIMEOUT_MS: '1000',
    SQS_REQUEST_TIMEOUT_MS: '3000',
  });
  await waitUntilLive(instance.url, instance.process);
  wallet = await openWallet(instance.url, '100.00');
}, 90_000);

afterAll(async () => {
  instance.process.kill();
  await instance.process.exited;
  proxy.close();
  await events.close();
  await queues.close();
  await db.close();
});

const appliedCount = (externalTransactionId: string) =>
  countRows(
    db,
    'select count(*)::int as n from wager_transactions where external_transaction_id = $1',
    [externalTransactionId],
  );

describe.each<FaultMode>(['refuse', 'blackhole'])('a temporary SQS outage (%s)', (mode) => {
  it('keeps the API up, holds events and messages, and loses nothing', async () => {
    const before = bet(wallet, '1.00');
    await enqueueOperation(queues.main, before);
    await eventually('the consumer works before the outage', async () => {
      return (await appliedCount(before.externalTransactionId)) === 1;
    });

    proxy.setMode(mode);
    const outageStarted = Date.now();

    // The API keeps accepting bets at normal speed: its path is PostgreSQL only.
    const accepted = [bet(wallet, '1.00'), bet(wallet, '1.00')];
    for (const operation of accepted) {
      const started = Date.now();
      expect((await postOperation(instance.url, operation)).status).toBe(201);
      expect(Date.now() - started).toBeLessThan(API_LATENCY_MS);
    }
    // The provider still reaches the broker; the application cannot.
    const queued = bet(wallet, '1.00');
    await enqueueOperation(queues.main, queued);

    expect(await statusOf(instance.url, '/health/ready')).toBe(503);
    expect(await statusOf(instance.url, '/health/live')).toBe(200);

    await Bun.sleep(Math.max(0, OUTAGE_MS - (Date.now() - outageStarted)));
    // Nothing went through while SQS was unreachable: events wait, the message waits.
    expect(await unpublishedEvents(db)).toBeGreaterThan(0);
    expect(await appliedCount(queued.externalTransactionId)).toBe(0);
    expect(instance.process.exitCode).toBeNull();

    proxy.setMode('pass');

    await eventually('the queue is drained', async () => (await queueDepth(queues.main)) === 0);
    expect(await queueDepth(queues.deadLetter)).toBe(0);
    await eventually('every event is published', async () => (await unpublishedEvents(db)) === 0);
    expect(await statusOf(instance.url, '/health/ready')).toBe(200);

    for (const operation of [before, ...accepted, queued]) await expectAppliedOnce(db, operation);
    await expectLedgerConsistent(db.sql, wallet.id);
    await expectReconciled(instance.url, wallet.id);
    expect(instance.process.exitCode).toBeNull();
  }, 90_000);
});

describe('events after the SQS outages', () => {
  it('every committed event reached the events queue', async () => {
    const received = new Set((await events.drain()).map((message) => String(message.body.eventId)));
    const committed: { id: string }[] = await db.sql.unsafe(
      'select id::text from outbox_messages order by id',
    );

    expect(committed.length).toBeGreaterThan(0);
    expect(committed.filter(({ id }) => !received.has(id))).toEqual([]);
  });
});
