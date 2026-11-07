import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { type Env } from '../../../src/infrastructure/config/env';
import { type ReadinessReport } from '../../../src/infrastructure/health/readiness-probe';
import { createTestApp, type TestApp } from '../support/test-app';
import { createTestDatabase, type TestDatabase } from '../support/test-database';
import { createTestQueue, type TestQueue } from '../support/test-queue';

/**
 * GET /health/ready against real dependencies (README §8: "PostgreSQL e SQS alcançáveis").
 * Each failure is real: a missing queue, an SQS endpoint and a database port nobody listens on.
 */
let db: TestDatabase;
let queue: TestQueue;
const apps: TestApp[] = [];

beforeAll(async () => {
  db = await createTestDatabase('http_readiness');
  queue = await createTestQueue(db.env, 'readiness');
});

afterAll(async () => {
  for (const app of apps) await app.close();
  await queue.close();
  await db.close();
});

async function appWith(overrides: Partial<Env>): Promise<TestApp> {
  const app = await createTestApp({
    ...db,
    env: { ...db.env, SQS_WAGER_QUEUE_NAME: queue.name, ...overrides },
  });
  apps.push(app);
  return app;
}

async function ready(app: TestApp) {
  const started = Date.now();
  const response = await app.request('GET', '/health/ready');
  return {
    status: response.status,
    report: response.body as ReadinessReport,
    raw: JSON.stringify(response.body),
    elapsedMs: Date.now() - started,
  };
}

describe('GET /health/ready', () => {
  it('answers 200 when PostgreSQL and the wager queue are reachable, without authentication', async () => {
    const { status, report } = await ready(await appWith({}));

    expect(status).toBe(200);
    expect(report.status).toBe('ok');
    expect(report.checks.postgres.status).toBe('up');
    expect(report.checks.sqs.status).toBe('up');
    expect(report.checks.postgres.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('answers 503 when the wager queue does not exist', async () => {
    const missing = `does-not-exist-${crypto.randomUUID().slice(0, 8)}.fifo`;
    const { status, report, raw } = await ready(await appWith({ SQS_WAGER_QUEUE_NAME: missing }));

    expect(status).toBe(503);
    expect(report).toMatchObject({
      status: 'unavailable',
      checks: { postgres: { status: 'up' }, sqs: { status: 'down' } },
    });
    expect(raw).not.toContain(missing); // no internal names in a public response
  });

  it('answers 503 within its timeout when the SQS endpoint is unreachable', async () => {
    const { status, report, raw, elapsedMs } = await ready(
      await appWith({ AWS_ENDPOINT_URL: 'http://127.0.0.1:1' }),
    );

    expect(status).toBe(503);
    expect(report.checks).toMatchObject({ postgres: { status: 'up' }, sqs: { status: 'down' } });
    expect(elapsedMs).toBeLessThan(3_000); // bounded by the 2s check timeout
    expect(raw).not.toContain('127.0.0.1');
  });

  it('answers 503 when PostgreSQL is unreachable, while liveness stays 200', async () => {
    const app = await appWith({ DATABASE_PORT: 1 });
    const { status, report, raw } = await ready(app);

    expect(status).toBe(503);
    expect(report.checks).toMatchObject({ postgres: { status: 'down' }, sqs: { status: 'up' } });
    expect(raw).not.toMatch(/ECONNREFUSED|5432|55432|localhost/);
    // Liveness does not depend on the database: an outage must not restart every instance.
    expect((await app.request('GET', '/health/live')).status).toBe(200);
  });
});
