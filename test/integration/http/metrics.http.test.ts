import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { type WalletView } from '../../../src/application/wallets/wallet-views';
import { uuid } from '../support/domain-fixtures';
import { sampleValue } from '../support/prometheus-text';
import { createTestApp, type TestApp } from '../support/test-app';
import { createTestDatabase, type TestDatabase } from '../support/test-database';

/**
 * README §12 metrics through the real application: each required item is checked as a series
 * on GET /metrics after the traffic that should produce it.
 */
let db: TestDatabase;
let api: TestApp;
/** Same database, lock_timeout of 300ms: makes a real lock conflict quick to provoke. */
let impatient: TestApp;

beforeAll(async () => {
  db = await createTestDatabase('http_metrics');
  api = await createTestApp(db);
  impatient = await createTestApp({ ...db, env: { ...db.env, DATABASE_LOCK_TIMEOUT_MS: 300 } });
});

afterAll(async () => {
  await impatient.close();
  await api.close();
  await db.close();
});

async function scrape(app: TestApp = api): Promise<{ text: string; contentType: string | null }> {
  const response = await fetch(`${app.baseUrl}/metrics`);
  expect(response.status).toBe(200);
  return { text: await response.text(), contentType: response.headers.get('content-type') };
}

const value = async (name: string, labels: Record<string, string> = {}, app = api) =>
  sampleValue((await scrape(app)).text, name, labels) ?? 0;

async function openWallet(amount = '100.00', app = api): Promise<WalletView> {
  const response = await app.request('POST', '/wallets', {
    playerId: uuid(),
    initialBalance: { amount, currency: 'BRL' },
  });
  return response.body as WalletView;
}

function bet(wallet: WalletView, amount = '25.00', externalTransactionId = `tx-${uuid()}`) {
  return {
    body: {
      providerId: 'provider-a',
      externalTransactionId,
      playerId: wallet.playerId,
      walletId: wallet.id,
      roundId: 'round-1',
      gameId: 'fortune-chimp',
      kind: 'BET',
      money: { amount, currency: 'BRL' },
    },
    headers: { 'idempotency-key': `provider-a:${externalTransactionId}` },
  };
}

const submit = (operation: ReturnType<typeof bet>, app = api) =>
  app.request('POST', '/wagering/transactions', operation.body, operation.headers);

describe('GET /metrics', () => {
  it('serves the Prometheus text format, with process metrics, without authentication', async () => {
    const { text, contentType } = await scrape();
    expect(contentType).toContain('text/plain');
    expect(text).toContain('# TYPE wager_transactions_total counter');
    expect(text).toContain('# TYPE wager_processing_duration_seconds histogram');
    expect(text).toContain('process_resident_memory_bytes');
    expect(text).toContain('nodejs_eventloop_lag_seconds');
  });

  it('counts transactions by status, duplicates and idempotency conflicts', async () => {
    const wallet = await openWallet('30.00');
    const first = bet(wallet, '25.00');
    const before = {
      processed: await value('wager_transactions_total', {
        kind: 'BET',
        status: 'PROCESSED',
        source: 'submission',
      }),
      rejected: await value('wager_transactions_total', {
        kind: 'BET',
        status: 'REJECTED',
        source: 'submission',
      }),
      replays: await value('wager_idempotent_replays_total', { entrypoint: 'http' }),
      conflicts: await value('wager_idempotency_conflicts_total', {
        entrypoint: 'http',
        code: 'IDEMPOTENCY_KEY_CONFLICT',
      }),
    };

    expect((await submit(first)).status).toBe(201);
    expect((await submit(first)).status).toBe(201); // replay
    const conflicting = {
      ...first,
      body: { ...first.body, money: { amount: '9.00', currency: 'BRL' } },
    };
    expect((await submit(conflicting)).status).toBe(409);
    expect((await submit(bet(wallet, '25.00'))).status).toBe(422); // insufficient funds

    expect(
      await value('wager_transactions_total', {
        kind: 'BET',
        status: 'PROCESSED',
        source: 'submission',
      }),
    ).toBe(before.processed + 1);
    expect(
      await value('wager_transactions_total', {
        kind: 'BET',
        status: 'REJECTED',
        source: 'submission',
      }),
    ).toBe(before.rejected + 1);
    expect(await value('wager_idempotent_replays_total', { entrypoint: 'http' })).toBe(
      before.replays + 1,
    );
    expect(
      await value('wager_idempotency_conflicts_total', {
        entrypoint: 'http',
        code: 'IDEMPOTENCY_KEY_CONFLICT',
      }),
    ).toBe(before.conflicts + 1);
  });

  it('measures processing latency, lock wait and HTTP duration by route template', async () => {
    const wallet = await openWallet();
    await submit(bet(wallet));
    await api.request('GET', `/wallets/${wallet.id}`);

    expect(
      await value('wager_processing_duration_seconds_count', {
        entrypoint: 'http',
        outcome: 'processed',
      }),
    ).toBeGreaterThan(0);
    expect(await value('wallet_lock_wait_seconds_count', { source: 'submission' })).toBeGreaterThan(
      0,
    );
    expect(
      await value('http_request_duration_seconds_count', {
        method: 'POST',
        route: '/wagering/transactions',
        status: '201',
      }),
    ).toBeGreaterThan(0);
    expect(
      await value('http_request_duration_seconds_count', {
        method: 'GET',
        route: '/wallets/:walletId',
        status: '200',
      }),
    ).toBeGreaterThan(0);
  });

  it('never puts ids or concrete URLs in labels (cardinality and player data)', async () => {
    const wallet = await openWallet();
    const operation = bet(wallet);
    const result = (await submit(operation)).body as { transactionId: string };
    await api.request('GET', `/no-such-route/${uuid()}`);

    const { text } = await scrape();
    expect(text).not.toContain(wallet.id);
    expect(text).not.toContain(wallet.playerId);
    expect(text).not.toContain(result.transactionId);
    expect(text).not.toContain(operation.body.externalTransactionId);
    expect(text).not.toContain('/no-such-route');
    expect(
      sampleValue(text, 'http_request_duration_seconds_count', {
        route: 'unmatched',
        status: '404',
      }),
    ).toBeGreaterThan(0);
  });

  it('counts a real lock timeout as a lock conflict and answers 503', async () => {
    const wallet = await openWallet('100.00', impatient);
    const before = await value('db_lock_conflicts_total', { reason: 'lock_timeout' }, impatient);

    // Another transaction holds the wallet row while the submission tries to lock it.
    let release: () => void = () => undefined;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    let locked: () => void = () => undefined;
    const isLocked = new Promise<void>((resolve) => {
      locked = resolve;
    });
    const holder = db.sql.begin(async (tx) => {
      await tx.unsafe('select id from wallets where id = $1 for update', [wallet.id]);
      locked();
      await released;
    });
    await isLocked;
    const response = await submit(bet(wallet), impatient);
    release();
    await holder;

    expect(response.status).toBe(503);
    expect(response.headers.get('retry-after')).not.toBeNull();
    expect(await value('db_lock_conflicts_total', { reason: 'lock_timeout' }, impatient)).toBe(
      before + 1,
    );
    expect(
      await value(
        'wager_processing_duration_seconds_count',
        { entrypoint: 'http', outcome: 'transient' },
        impatient,
      ),
    ).toBeGreaterThan(0);
  });
});
