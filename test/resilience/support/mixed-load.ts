import { expect } from 'bun:test';
import { type WalletView } from '../../../src/application/wallets/wallet-views';
import { type Env } from '../../../src/infrastructure/config/env';
import { type Instance, spawnInstance, waitUntilLive } from '../../concurrency/support/instances';
import { bet } from '../../concurrency/support/wagering-client';
import { expectLedgerConsistent } from '../../integration/support/invariants';
import { type TestDatabase } from '../../integration/support/test-database';
import { type QueuePair, type TestQueue } from '../../integration/support/test-queue';
import { eventually, queueDepth } from './eventually';
import {
  countRows,
  enqueueOperation,
  expectAppliedOnce,
  expectReconciled,
  type Operation,
  postOperation,
  rollbackOf,
  unpublishedEvents,
} from './operations';

/**
 * Mixed load for the resilience suites: per wallet, BETs and WINs over HTTP, BETs over SQS
 * (each message delivered twice) and ROLLBACKs delivered BEFORE the BETs they reverse. Every
 * operation is affordable, so the final balance of each wallet is known in advance: any lost or
 * duplicated effect shows up as a wrong balance, not only as a ledger mismatch.
 */
export interface WalletLoad {
  wallet: WalletView;
  http: Operation[];
  queued: Operation[];
  earlyRollbacks: Operation[];
  expectedBalance: string;
}

const INITIAL_BALANCE = '100.00';
const HTTP_BETS = 8;
const HTTP_WINS = 4;
const QUEUED_BETS = 8;
const ROLLED_BACK = 2;

export { INITIAL_BALANCE };

export function planWalletLoad(wallet: WalletView): WalletLoad {
  const httpBets = Array.from({ length: HTTP_BETS }, () => bet(wallet, '1.00'));
  const wins = Array.from({ length: HTTP_WINS }, () => ({ ...bet(wallet, '0.50'), kind: 'WIN' }));
  const earlyRollbacks = httpBets
    .slice(0, ROLLED_BACK)
    .map((reversed) => rollbackOf(wallet, reversed.externalTransactionId));
  // In cents: 100.00 - 16 bets of 1.00 + 4 wins of 0.50 + 2 rollbacks of 1.00 = 88.00.
  const cents = 10_000 - (HTTP_BETS + QUEUED_BETS) * 100 + HTTP_WINS * 50 + ROLLED_BACK * 100;
  return {
    wallet,
    http: [...httpBets, ...wins],
    queued: Array.from({ length: QUEUED_BETS }, () => bet(wallet, '1.00')),
    earlyRollbacks,
    expectedBalance: `${String(Math.floor(cents / 100))}.${String(cents % 100).padStart(2, '0')}`,
  };
}

/** Every role, short intervals and a short outbox lease, so recovery fits in a test. */
export function resilientNodeEnv(queues: QueuePair, events: TestQueue): Record<string, string> {
  return {
    APP_ROLES: 'api,consumer,outbox,pending',
    SQS_WAGER_QUEUE_NAME: queues.main.name,
    SQS_WAGER_DLQ_NAME: queues.deadLetter.name,
    SQS_EVENTS_QUEUE_NAME: events.name,
    SQS_CONSUMER_WAIT_TIME_SECONDS: '1',
    OUTBOX_POLL_INTERVAL_MS: '200',
    OUTBOX_LEASE_MS: '3000',
    OUTBOX_RETRY_BASE_DELAY_MS: '200',
    OUTBOX_RETRY_MAX_DELAY_MS: '1000',
    PENDING_REFERENCE_POLL_INTERVAL_MS: '100',
    PENDING_REFERENCE_BASE_DELAY_MS: '200',
    PENDING_REFERENCE_MAX_DELAY_MS: '1000',
    PENDING_REFERENCE_MAX_ATTEMPTS: '60',
  };
}

/** A set of application processes that can lose members and gain new ones mid-test. */
export class Nodes {
  private readonly all: Instance[] = [];

  constructor(
    private readonly env: Env,
    private readonly overrides: Record<string, string>,
  ) {}

  async start(count: number): Promise<Instance[]> {
    const started = Array.from({ length: count }, () => spawnInstance(this.env, this.overrides));
    this.all.push(...started);
    await Promise.all(started.map((node) => waitUntilLive(node.url, node.process)));
    return started;
  }

  /** URLs of the processes not killed yet (a dead one may still be in its last milliseconds). */
  liveUrls(): string[] {
    return this.all.filter((node) => !node.process.killed).map((node) => node.url);
  }

  live(): Instance[] {
    return this.all.filter((node) => !node.process.killed);
  }

  /** SIGKILL: no shutdown hook runs, in-flight work is cut wherever it is. */
  async kill(nodes: Instance[]): Promise<void> {
    for (const node of nodes) node.process.kill('SIGKILL');
    await Promise.all(nodes.map((node) => node.process.exited));
  }

  async stopAll(): Promise<void> {
    await this.kill(this.live());
  }
}

/**
 * Submits like a real provider would: on a connection error (the process died) or a 503, it
 * retries the SAME request, with the same idempotency key, on another live process. Accepts
 * 201 / 202, and 200 for a replay of a request a dying process had already committed.
 */
export async function submitWithFailover(
  nodes: Nodes,
  operation: Operation,
  stats: LoadStats,
  firstNode: number,
  timeoutMs = 90_000,
): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  let attempt = firstNode;
  while (Date.now() < deadline) {
    const urls = nodes.liveUrls();
    const url = urls[attempt % Math.max(urls.length, 1)];
    attempt++;
    if (url) {
      let status: number | undefined;
      try {
        status = (await postOperation(url, operation)).status;
      } catch {
        // connection refused or reset: that process is gone, try another one
      }
      if (status === 200) stats.replays++;
      if (status === 200 || status === 201 || status === 202) return status;
      if (status !== undefined && status !== 503) {
        throw new Error(`unexpected ${String(status)} for ${operation.externalTransactionId}`);
      }
      stats.retries++;
    }
    await Bun.sleep(100);
  }
  throw new Error(`${operation.externalTransactionId} was never accepted`);
}

/** What the provider side saw: retried attempts (dead process or 503) and replays (200). */
export interface LoadStats {
  retries: number;
  replays: number;
}

/**
 * Runs the HTTP side of every wallet's load, `concurrency` requests at a time, spread round-robin
 * over the processes (each request starts on a different one).
 */
export async function runHttpLoad(
  nodes: Nodes,
  operations: Operation[],
  concurrency: number,
  onProgress: (completed: number) => void,
): Promise<LoadStats> {
  const stats: LoadStats = { retries: 0, replays: 0 };
  let next = 0;
  let completed = 0;
  const lane = async () => {
    for (let index = next++; index < operations.length; index = next++) {
      const operation = operations[index];
      if (!operation) return;
      await submitWithFailover(nodes, operation, stats, index);
      onProgress(++completed);
    }
  };
  await Promise.all(Array.from({ length: concurrency }, lane));
  return stats;
}

/** Sends each queued operation twice: at-least-once delivery, as SQS may do. */
export async function enqueueTwice(queue: TestQueue, operations: Operation[]): Promise<void> {
  for (const operation of operations) {
    await enqueueOperation(queue, operation);
    await enqueueOperation(queue, operation);
  }
}

export const pendingReferences = (db: TestDatabase) =>
  countRows(
    db,
    `select count(*)::int as n from wager_transactions where status = 'PENDING_REFERENCE'`,
  );

/** Waits for every queue, worker and outbox to go quiet. */
export async function waitUntilSettled(
  db: TestDatabase,
  queues: QueuePair,
  timeoutMs = 90_000,
): Promise<void> {
  await eventually(
    'the wager queue is drained',
    async () => (await queueDepth(queues.main)) === 0,
    timeoutMs,
  );
  await eventually(
    'every pending reference is resolved',
    async () => (await pendingReferences(db)) === 0,
    timeoutMs,
  );
  await eventually(
    'every event is published',
    async () => (await unpublishedEvents(db)) === 0,
    timeoutMs,
  );
}

/**
 * README §13 final invariant, and more: every operation applied exactly once, each wallet at its
 * precomputed balance, ledger and reconciliation consistent, nothing dead-lettered, and every
 * committed event delivered at least once.
 */
export async function expectFinalConsistency(
  db: TestDatabase,
  queues: QueuePair,
  events: TestQueue,
  loads: WalletLoad[],
  apiUrl: string,
): Promise<void> {
  expect(await queueDepth(queues.deadLetter)).toBe(0);
  expect(
    await countRows(
      db,
      `select count(*)::int as n from wager_transactions where status <> 'PROCESSED'`,
    ),
  ).toBe(0);

  for (const load of loads) {
    for (const operation of [...load.earlyRollbacks, ...load.http, ...load.queued]) {
      await expectAppliedOnce(db, operation);
    }
    const rows: { balance: string }[] = await db.sql.unsafe(
      'select balance::numeric(38, 2)::text as balance from wallets where id = $1',
      [load.wallet.id],
    );
    expect({ wallet: load.wallet.id, balance: rows[0]?.balance }).toEqual({
      wallet: load.wallet.id,
      balance: load.expectedBalance,
    });
    await expectLedgerConsistent(db.sql, load.wallet.id);
    await expectReconciled(apiUrl, load.wallet.id);
  }

  const delivered = new Set((await events.drain()).map((message) => String(message.body.eventId)));
  const committed: { id: string }[] = await db.sql.unsafe('select id::text from outbox_messages');
  expect(committed.filter(({ id }) => !delivered.has(id))).toEqual([]);
}
