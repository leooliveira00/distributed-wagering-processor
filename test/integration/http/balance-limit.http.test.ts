import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { type WalletView } from '../../../src/application/wallets/wallet-views';
import { expectLedgerConsistent } from '../support/invariants';
import { createTestApp, type TestApp } from '../support/test-app';
import { createTestDatabase, type TestDatabase } from '../support/test-database';

/**
 * A balance is stored as numeric(20,2). A credit that would pass that capacity is a business
 * outcome the provider must be told about (422, persisted, auditable), never a numeric overflow
 * that surfaces as a 500 at write time.
 */
let db: TestDatabase;
let app: TestApp;

beforeAll(async () => {
  db = await createTestDatabase('http_balance_limit');
  app = await createTestApp(db);
});

afterAll(async () => {
  await app.close();
  await db.close();
});

describe('a credit past the largest storable balance', () => {
  it('is rejected with 422 BALANCE_LIMIT_EXCEEDED and leaves the wallet untouched', async () => {
    const wallet = (
      await app.request('POST', '/wallets', {
        playerId: crypto.randomUUID(),
        initialBalance: { amount: '999999999999999999.99', currency: 'BRL' },
      })
    ).body as WalletView;

    const response = await app.request(
      'POST',
      '/wagering/transactions',
      {
        providerId: 'provider-a',
        externalTransactionId: 'win-1',
        playerId: wallet.playerId,
        walletId: wallet.id,
        roundId: 'round-1',
        gameId: 'fortune-chimp',
        kind: 'WIN',
        money: { amount: '0.01', currency: 'BRL' },
      },
      { 'idempotency-key': 'provider-a:win-1' },
    );

    expect(response.status).toBe(422);
    expect(response.body).toMatchObject({
      status: 'REJECTED',
      failureCode: 'BALANCE_LIMIT_EXCEEDED',
      balance: { amount: '999999999999999999.99', currency: 'BRL' },
      error: { code: 'BALANCE_LIMIT_EXCEEDED', retryable: false },
    });
    const after = (await app.request('GET', `/wallets/${wallet.id}`)).body as WalletView;
    expect(after).toMatchObject({ balance: { amount: '999999999999999999.99' }, version: 1 });
    await expectLedgerConsistent(db.sql, wallet.id);
  });
});
