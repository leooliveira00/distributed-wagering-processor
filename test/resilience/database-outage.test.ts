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
  rollbackOf,
  statusOf,
  unpublishedEvents,
} from './support/operations';

/**
 * README §3: "PostgreSQL ... pode ficar temporariamente indisponível". A real process (every
 * role) reaches PostgreSQL through a TCP proxy the test controls. During the outage nothing may
 * hang, crash or be acknowledged; after it, every operation has exactly one financial effect.
 *
 * Two kinds of outage: `refuse` (connections reset and refused, e.g. a database restart) and
 * `blackhole` (a network partition: open sockets go silent, nothing errors on its own).
 */
const OUTAGE_MS = 5_000;
/** Max time an operation may take to fail while the database is unreachable. */
const FAIL_FAST_MS = 8_000;

let db: TestDatabase;
let queues: QueuePair;
let events: TestQueue;
let proxy: FaultProxy;
let instance: Instance;
let wallet: WalletView;

beforeAll(async () => {
  db = await createTestDatabase('resilience_database_outage');
  queues = await createQueuePair(db.env, 'resilience-db-outage', {
    visibilityTimeoutSeconds: 5,
    maxReceiveCount: 10,
  });
  events = await createTestQueue(db.env, 'resilience-db-outage-events');
  proxy = startFaultProxy({ host: db.env.DATABASE_HOST, port: db.env.DATABASE_PORT });
  instance = spawnInstance(db.env, {
    APP_ROLES: 'api,consumer,outbox,pending',
    DATABASE_HOST: '127.0.0.1',
    DATABASE_PORT: String(proxy.port),
    SQS_WAGER_QUEUE_NAME: queues.main.name,
    SQS_WAGER_DLQ_NAME: queues.deadLetter.name,
    SQS_EVENTS_QUEUE_NAME: events.name,
    SQS_CONSUMER_WAIT_TIME_SECONDS: '1',
    OUTBOX_POLL_INTERVAL_MS: '200',
    PENDING_REFERENCE_POLL_INTERVAL_MS: '100',
    PENDING_REFERENCE_BASE_DELAY_MS: '200',
    PENDING_REFERENCE_MAX_DELAY_MS: '1000',
    PENDING_REFERENCE_MAX_ATTEMPTS: '30',
    // Short client-side bounds keep the suite fast; production defaults are 5s / 15s / 20s.
    DATABASE_CONNECT_TIMEOUT_MS: '2000',
    DATABASE_STATEMENT_TIMEOUT_MS: '2000',
    DATABASE_QUERY_TIMEOUT_MS: '3000',
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

describe.each<FaultMode>(['refuse', 'blackhole'])('a temporary database outage (%s)', (mode) => {
  it('fails fast, keeps the process alive and loses nothing', async () => {
    const before = bet(wallet, '1.00');
    expect((await postOperation(instance.url, before)).status).toBe(201);
    // Work in flight when the database goes away: the pending-reference worker holds a ROLLBACK
    // whose BET does not exist yet, and the outbox holds the events just committed.
    const lateBet = bet(wallet, '1.00');
    const earlyRollback = rollbackOf(wallet, lateBet.externalTransactionId);
    expect((await postOperation(instance.url, earlyRollback)).status).toBe(202);

    proxy.setMode(mode);
    const outageStarted = Date.now();

    // Queue traffic arrives during the outage: it must stay in the queue, not be acknowledged.
    // The late BET is among it, so the ROLLBACK can only resolve after the recovery.
    const queued = [bet(wallet, '1.00'), lateBet];
    for (const operation of queued) await enqueueOperation(queues.main, operation);

    // HTTP traffic during the outage: a retryable 503, quickly, never a 500 or a hang.
    const during = bet(wallet, '1.00');
    const started = Date.now();
    const response = await postOperation(instance.url, during);
    const elapsedMs = Date.now() - started;
    expect(response.status).toBe(503);
    expect(response.headers.get('retry-after')).not.toBeNull();
    expect(elapsedMs).toBeLessThan(FAIL_FAST_MS);

    expect(await statusOf(instance.url, '/health/ready')).toBe(503);
    expect(await statusOf(instance.url, '/health/live')).toBe(200);

    await Bun.sleep(Math.max(0, OUTAGE_MS - (Date.now() - outageStarted)));
    expect(instance.process.exitCode).toBeNull();

    proxy.setMode('pass');

    // A provider retries the same request with the same key until it is accepted.
    await eventually('the retried request is accepted', async () => {
      const retried = await postOperation(instance.url, during);
      return retried.status === 201 || retried.status === 200;
    });
    await eventually('the queue is drained', async () => (await queueDepth(queues.main)) === 0);
    expect(await queueDepth(queues.deadLetter)).toBe(0);
    await eventually('every event is published', async () => (await unpublishedEvents(db)) === 0);
    await eventually(
      'the pending ROLLBACK is resolved',
      async () =>
        (await countRows(
          db,
          `select count(*)::int as n from wager_transactions where status = 'PENDING_REFERENCE'`,
        )) === 0,
    );
    expect(await statusOf(instance.url, '/health/ready')).toBe(200);

    for (const operation of [before, earlyRollback, ...queued, during]) {
      await expectAppliedOnce(db, operation);
    }
    await expectLedgerConsistent(db.sql, wallet.id);
    await expectReconciled(instance.url, wallet.id);
    expect(instance.process.exitCode).toBeNull();
  }, 90_000);
});
