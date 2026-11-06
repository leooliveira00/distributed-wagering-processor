import { afterAll, beforeAll, describe, it } from 'bun:test';
import { createTestApp, type TestApp } from '../integration/support/test-app';
import { createTestDatabase, type TestDatabase } from '../integration/support/test-database';
import {
  competingBets,
  hotWallet,
  independentWallets,
  sameBetFiftyTimes,
} from './support/scenarios';

/** Real parallelism against one application instance (no mocks, no sequential fakes). */
let db: TestDatabase;
let api: TestApp;
const pick = () => api.baseUrl;

beforeAll(async () => {
  db = await createTestDatabase('concurrency_single');
  api = await createTestApp(db);
});

afterAll(async () => {
  await api.close();
  await db.close();
});

describe('concurrency on a single instance', () => {
  it(
    'the same BET 50 times in parallel debits once',
    () => sameBetFiftyTimes(db.sql, pick),
    30_000,
  );

  it(
    'two simultaneous BETs of 80.00 on 100.00: one processed, one rejected (x10)',
    () => competingBets(db.sql, pick, 10),
    30_000,
  );

  it(
    'a hot wallet never goes negative under 30 competing BETs',
    () => hotWallet(db.sql, pick),
    30_000,
  );

  it(
    'independent wallets are processed in parallel correctly',
    () => independentWallets(db.sql, pick),
    30_000,
  );
});
