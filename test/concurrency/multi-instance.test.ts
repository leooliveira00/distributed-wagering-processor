import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { createTestDatabase, type TestDatabase } from '../integration/support/test-database';
import { type Cluster, startCluster } from './support/instances';
import {
  competingBets,
  hotWallet,
  independentWallets,
  sameBetFiftyTimes,
} from './support/scenarios';

/**
 * README §8/§13.4: three real application processes share one database. Requests are spread
 * round-robin, so duplicates and competing writes always cross process boundaries.
 */
const INSTANCES = 3;
let db: TestDatabase;
let cluster: Cluster;
const pick = () => cluster.next().url;

beforeAll(async () => {
  db = await createTestDatabase('concurrency_multi');
  cluster = await startCluster(INSTANCES, db.env);
}, 90_000);

afterAll(async () => {
  await cluster.stop();
  await db.close();
});

describe(`concurrency across ${String(INSTANCES)} instances`, () => {
  it('runs as separate operating system processes', () => {
    const pids = new Set(cluster.instances.map((instance) => instance.process.pid));
    expect(pids.size).toBe(INSTANCES);
    expect(pids.has(process.pid)).toBe(false);
  });

  it(
    'the same BET 50 times across instances debits once',
    () => sameBetFiftyTimes(db.sql, pick),
    60_000,
  );

  it(
    'competing BETs on different instances: one processed, one rejected (x10)',
    () => competingBets(db.sql, pick, 10),
    60_000,
  );

  it(
    'a hot wallet hit from every instance never goes negative',
    () => hotWallet(db.sql, pick),
    60_000,
  );

  it(
    'independent wallets spread across instances end up exact',
    () => independentWallets(db.sql, pick),
    60_000,
  );
});
