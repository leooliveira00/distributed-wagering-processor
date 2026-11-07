import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { type WalletView } from '../../../src/application/wallets/wallet-views';
import { expectLedgerConsistent } from '../support/invariants';
import { createTestApp, type TestApp } from '../support/test-app';
import { createTestDatabase, type TestDatabase } from '../support/test-database';

/**
 * UUIDs are case-insensitive (RFC 9562). The same wallet and player written in uppercase must be
 * the same wallet and player: not a 500, not a false PLAYER_WALLET_MISMATCH, and the same
 * operation in another letter case must be a replay, not an idempotency conflict.
 */
let db: TestDatabase;
let app: TestApp;

beforeAll(async () => {
  db = await createTestDatabase('http_uuid_case');
  app = await createTestApp(db);
});

afterAll(async () => {
  await app.close();
  await db.close();
});

describe('UUIDs in uppercase', () => {
  it('address the same wallet and player, and the same operation is a replay', async () => {
    const playerId = crypto.randomUUID();
    const created = await app.request('POST', '/wallets', {
      playerId: playerId.toUpperCase(),
      initialBalance: { amount: '100.00', currency: 'BRL' },
    });
    expect(created.status).toBe(201);
    const wallet = created.body as WalletView;
    expect(wallet.playerId).toBe(playerId); // stored in canonical form

    const bet = (ids: { walletId: string; playerId: string }) => ({
      providerId: 'provider-a',
      externalTransactionId: 'bet-1',
      ...ids,
      roundId: 'round-1',
      gameId: 'fortune-chimp',
      kind: 'BET',
      money: { amount: '25.00', currency: 'BRL' },
    });
    const headers = { 'idempotency-key': 'provider-a:bet-1' };

    const upper = await app.request(
      'POST',
      '/wagering/transactions',
      bet({ walletId: wallet.id.toUpperCase(), playerId: playerId.toUpperCase() }),
      headers,
    );
    expect(upper.status).toBe(201);
    expect(upper.body).toMatchObject({ status: 'PROCESSED', idempotentReplay: false });

    const lower = await app.request(
      'POST',
      '/wagering/transactions',
      bet({ walletId: wallet.id, playerId }),
      headers,
    );
    expect(lower.status).toBe(201);
    expect(lower.body).toMatchObject({ status: 'PROCESSED', idempotentReplay: true });

    const fetched = await app.request('GET', `/wallets/${wallet.id.toUpperCase()}`);
    expect(fetched.body).toMatchObject({ id: wallet.id, balance: { amount: '75.00' } });
    await expectLedgerConsistent(db.sql, wallet.id);
  });
});
