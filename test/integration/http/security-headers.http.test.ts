import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { createTestApp, type TestApp } from '../support/test-app';
import { createTestDatabase, type TestDatabase } from '../support/test-database';

/** No response may tell a client which framework serves it (fingerprinting). */
let db: TestDatabase;
let app: TestApp;

beforeAll(async () => {
  db = await createTestDatabase('http_security_headers');
  app = await createTestApp(db);
});

afterAll(async () => {
  await app.close();
  await db.close();
});

describe('response headers', () => {
  it.each([
    ['a successful response', 'GET', '/health/live', 200],
    ['a validation error', 'POST', '/wallets', 400],
    ['an unknown route', 'GET', '/no-such-route', 404],
  ])('never announce the framework on %s', async (_, method, path, status) => {
    const response = await app.request(method, path, method === 'POST' ? {} : undefined);

    expect(response.status).toBe(status);
    expect(response.headers.get('x-powered-by')).toBeNull();
  });
});
