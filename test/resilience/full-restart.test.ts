import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { openWallet } from '../concurrency/support/wagering-client';
import { createTestDatabase, type TestDatabase } from '../integration/support/test-database';
import {
  createQueuePair,
  createTestQueue,
  type QueuePair,
  type TestQueue,
} from '../integration/support/test-queue';
import { eventually, queueDepth } from './support/eventually';
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
import { enqueueOperation, unpublishedEvents } from './support/operations';
import { seededRandom } from './support/seeded-random';

/**
 * README §13, concurrency item 8: "reinício do serviço com comprovação da consistência final".
 * Every process gets SIGKILL at once, mid-load, leaving work everywhere: messages in the queue
 * and in flight, events not published (or claimed under a lease nobody will release) and
 * reversals waiting for their BETs. A brand new set of processes, sharing nothing with the old
 * one but PostgreSQL and SQS, must finish it all, and every wallet must reconcile.
 */
const WALLETS = 4;

let db: TestDatabase;
let queues: QueuePair;
let events: TestQueue;
let nodes: Nodes;
let loads: WalletLoad[];

beforeAll(async () => {
  db = await createTestDatabase('resilience_full_restart');
  queues = await createQueuePair(db.env, 'resilience-restart', {
    visibilityTimeoutSeconds: 5,
    maxReceiveCount: 10,
  });
  events = await createTestQueue(db.env, 'resilience-restart-events');
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

describe('a full restart of the service in the middle of the load', () => {
  it('lets a new set of processes finish every operation, and every wallet reconciles', async () => {
    const earlyRollbacks = loads.flatMap((load) => load.earlyRollbacks);
    for (const rollback of earlyRollbacks) await enqueueOperation(queues.main, rollback);
    await eventually(
      'the early rollbacks wait for their BETs',
      async () => (await pendingReferences(db)) === earlyRollbacks.length,
    );

    const random = seededRandom('full-restart');
    const http = random.shuffle(loads.flatMap((load) => load.http));
    const killAfter = Math.ceil(http.length * (0.2 + random.next() * 0.4));
    let restarted: Promise<void> | undefined;
    const restart = async () => {
      const old = nodes.live();
      await nodes.kill(old);
      // Work left behind by the dead set, before anything new runs.
      const left = {
        queued: await queueDepth(queues.main),
        unpublished: await unpublishedEvents(db),
        pending: await pendingReferences(db),
      };
      console.info(
        `killed 3 of 3 after ${String(killAfter)}/${String(http.length)} HTTP operations;`,
        `left behind: ${String(left.queued)} messages, ${String(left.unpublished)} events,`,
        `${String(left.pending)} pending references`,
      );
      expect(left.queued + left.unpublished + left.pending).toBeGreaterThan(0);
      await nodes.start(3);
    };

    // The provider keeps retrying during the downtime; the new processes take those requests.
    const [, stats] = await Promise.all([
      enqueueTwice(
        queues.main,
        loads.flatMap((load) => load.queued),
      ),
      runHttpLoad(nodes, http, 6, (completed) => {
        if (completed === killAfter) restarted = restart();
      }),
    ]);
    await restarted;
    console.info(`provider retries: ${String(stats.retries)}, replays: ${String(stats.replays)}`);
    expect(nodes.live()).toHaveLength(3);

    await waitUntilSettled(db, queues);
    const [fresh] = nodes.live();
    if (!fresh) throw new Error('no process after the restart');
    await expectFinalConsistency(db, queues, events, loads, fresh.url);
  }, 240_000);
});
