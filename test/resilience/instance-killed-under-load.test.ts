import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { openWallet } from '../concurrency/support/wagering-client';
import { createTestDatabase, type TestDatabase } from '../integration/support/test-database';
import {
  createQueuePair,
  createTestQueue,
  type QueuePair,
  type TestQueue,
} from '../integration/support/test-queue';
import { eventually } from './support/eventually';
import {
  enqueueTwice,
  expectFinalConsistency,
  INITIAL_BALANCE,
  Nodes,
  pendingReferences,
  planWalletLoad,
  resilientNodeEnv,
  runHttpLoad,
  type WalletLoad,
  waitUntilSettled,
} from './support/mixed-load';
import { enqueueOperation } from './support/operations';
import { seededRandom } from './support/seeded-random';

/**
 * README §8 / §11 / §13: three processes with every role share PostgreSQL and the queues. While
 * a mixed HTTP + SQS load runs on several wallets, ONE of them gets SIGKILL at an arbitrary point
 * (no fault injection: wherever it happens to be, mid-request, mid-message or mid-publish). The
 * provider retries failed requests on the survivors, which finish all the work.
 */
const WALLETS = 4;

let db: TestDatabase;
let queues: QueuePair;
let events: TestQueue;
let nodes: Nodes;
let loads: WalletLoad[];

beforeAll(async () => {
  db = await createTestDatabase('resilience_instance_killed');
  queues = await createQueuePair(db.env, 'resilience-killed', {
    visibilityTimeoutSeconds: 5,
    maxReceiveCount: 10,
  });
  events = await createTestQueue(db.env, 'resilience-killed-events');
  nodes = new Nodes(db.env, resilientNodeEnv(queues, events));
  const [first] = await nodes.start(3);
  if (!first) throw new Error('no node started');
  loads = [];
  for (let index = 0; index < WALLETS; index++) {
    loads.push(planWalletLoad(await openWallet(first.url, INITIAL_BALANCE)));
  }
}, 120_000);

afterAll(async () => {
  await nodes.stopAll();
  await events.close();
  await queues.close();
  await db.close();
});

describe('an instance killed at an arbitrary point under mixed load', () => {
  it('leaves the survivors to finish everything, exactly once', async () => {
    // Reversals first: they wait as PENDING_REFERENCE for BETs that arrive later over HTTP.
    const earlyRollbacks = loads.flatMap((load) => load.earlyRollbacks);
    for (const rollback of earlyRollbacks) await enqueueOperation(queues.main, rollback);
    await eventually(
      'the early rollbacks wait for their BETs',
      async () => (await pendingReferences(db)) === earlyRollbacks.length,
    );

    const random = seededRandom('instance-killed-under-load');
    const http = random.shuffle(loads.flatMap((load) => load.http));
    // Somewhere between 20% and 60% of the HTTP load: always mid-load, never at a chosen line.
    const killAfter = Math.ceil(http.length * (0.2 + random.next() * 0.4));
    const victim = nodes.live()[random.int(3)];
    if (!victim) throw new Error('no victim');
    let killed: Promise<void> | undefined;

    const [, stats] = await Promise.all([
      enqueueTwice(
        queues.main,
        loads.flatMap((load) => load.queued),
      ),
      runHttpLoad(nodes, http, 6, (completed) => {
        if (completed === killAfter) killed = nodes.kill([victim]);
      }),
    ]);
    await killed;
    // Diagnostics only: whether the kill caught requests in flight depends on the timing.
    console.info(
      `killed 1 of 3 after ${String(killAfter)}/${String(http.length)} HTTP operations;`,
      `provider retries: ${String(stats.retries)}, replays: ${String(stats.replays)}`,
    );

    expect(victim.process.killed).toBe(true);
    expect(nodes.live()).toHaveLength(2);

    await waitUntilSettled(db, queues);
    const [survivor] = nodes.live();
    if (!survivor) throw new Error('no survivor');
    await expectFinalConsistency(db, queues, events, loads, survivor.url);
  }, 180_000);
});
