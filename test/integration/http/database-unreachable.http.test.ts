import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { type Env } from '../../../src/infrastructure/config/env';
import { createTestApp, type TestApp } from '../support/test-app';
import { createTestDatabase, type TestDatabase } from '../support/test-database';

/**
 * README §9: a temporary infrastructure failure must be told apart from every other outcome, so
 * the provider knows it may resend. Each failure here is real: a database host name that does not
 * resolve (`.invalid` never does, RFC 2606; it is what a stopped `postgres` container looks like
 * inside the compose network) and a port nobody listens on.
 */
let db: TestDatabase;
const apps: TestApp[] = [];

beforeAll(async () => {
  db = await createTestDatabase('http_database_unreachable');
});

afterAll(async () => {
  for (const app of apps) await app.close();
  await db.close();
});

const submission = {
  providerId: 'provider-a',
  externalTransactionId: 'tx-unreachable',
  playerId: crypto.randomUUID(),
  walletId: crypto.randomUUID(),
  roundId: 'round-1',
  gameId: 'fortune-chimp',
  kind: 'BET',
  money: { amount: '10.00', currency: 'BRL' },
};

describe('POST /wagering/transactions while PostgreSQL is unreachable', () => {
  it.each<[string, Partial<Env>]>([
    ['its host name does not resolve', { DATABASE_HOST: 'db.invalid' }],
    ['its port refuses connections', { DATABASE_PORT: 1 }],
  ])('answers a retryable 503 when %s', async (_, overrides) => {
    const app = await createTestApp({
      ...db,
      env: { ...db.env, DATABASE_CONNECT_TIMEOUT_MS: 2_000, ...overrides },
    });
    apps.push(app);

    const response = await app.request('POST', '/wagering/transactions', submission, {
      'idempotency-key': 'provider-a:tx-unreachable',
    });

    expect(response.status).toBe(503);
    expect(response.headers.get('retry-after')).not.toBeNull();
    expect(response.body).toMatchObject({
      error: { code: 'SERVICE_UNAVAILABLE', retryable: true },
    });
  });
});
