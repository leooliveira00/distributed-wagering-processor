import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { createTestApp, type TestApp } from '../support/test-app';
import { createTestDatabase, type TestDatabase } from '../support/test-database';

let db: TestDatabase;
let api: TestApp;

beforeAll(async () => {
  db = await createTestDatabase('http_correlation');
  api = await createTestApp(db);
});

afterAll(async () => {
  await api.close();
  await db.close();
});

const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('X-Correlation-Id', () => {
  it('echoes a well-formed caller id', async () => {
    const response = await api.request('GET', '/health/live', undefined, {
      'x-correlation-id': 'caller-123:abc',
    });
    expect(response.headers.get('x-correlation-id')).toBe('caller-123:abc');
  });

  it('starts a new id when the caller sends none', async () => {
    const response = await api.request('GET', '/health/live');
    expect(response.headers.get('x-correlation-id')).toMatch(UUID_V7);
  });

  it('replaces a malformed id instead of trusting it (it would reach the logs)', async () => {
    const response = await api.request('GET', '/health/live', undefined, {
      'x-correlation-id': 'not safe {"injected":true}',
    });
    expect(response.headers.get('x-correlation-id')).toMatch(UUID_V7);
  });

  it('is present on error responses too', async () => {
    const response = await api.request('GET', '/wallets/not-a-uuid', undefined, {
      'x-correlation-id': 'corr-error-1',
    });
    expect(response.status).toBe(400);
    expect(response.headers.get('x-correlation-id')).toBe('corr-error-1');
  });

  it('gives concurrent requests their own ids', async () => {
    const responses = await Promise.all(
      Array.from({ length: 10 }, (_, index) =>
        api.request('GET', '/health/live', undefined, { 'x-correlation-id': `c-${String(index)}` }),
      ),
    );
    responses.forEach((response, index) => {
      expect(response.headers.get('x-correlation-id')).toBe(`c-${String(index)}`);
    });
  });
});
