import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { type WalletView } from '../../../src/application/wallets/wallet-views';
import { createTestApp, type TestApp } from '../support/test-app';
import { createTestDatabase, type TestDatabase } from '../support/test-database';

/**
 * A transaction the pending worker gave up on (FAILED / PROCESSING_FAILED) is terminal. Resending
 * it is a replay like any other, but its answer must say "failed for good, do not resend": a 500
 * with the uniform error envelope and retryable=false, never a 2xx.
 */
let db: TestDatabase;
let app: TestApp;

beforeAll(async () => {
  db = await createTestDatabase('http_failed_replay');
  app = await createTestApp(db);
});

afterAll(async () => {
  await app.close();
  await db.close();
});

describe('replaying a FAILED transaction', () => {
  it('answers 500 PROCESSING_FAILED, not retryable, with the transaction', async () => {
    const wallet = (
      await app.request('POST', '/wallets', {
        playerId: crypto.randomUUID(),
        initialBalance: { amount: '100.00', currency: 'BRL' },
      })
    ).body as WalletView;
    const refund = {
      providerId: 'provider-a',
      externalTransactionId: 'refund-1',
      playerId: wallet.playerId,
      walletId: wallet.id,
      roundId: 'round-1',
      gameId: 'fortune-chimp',
      kind: 'REFUND',
      money: { amount: '10.00', currency: 'BRL' },
      referenceExternalTransactionId: 'bet-never-sent',
    };
    const headers = { 'idempotency-key': 'provider-a:refund-1' };
    expect((await app.request('POST', '/wagering/transactions', refund, headers)).status).toBe(202);
    // What the worker does after repeated processing failures (covered by its own tests).
    await db.sql.unsafe(
      `update wager_transactions
          set status = 'FAILED', failure_code = 'PROCESSING_FAILED', next_attempt_at = null
        where provider_id = 'provider-a' and external_transaction_id = 'refund-1'`,
    );

    const replay = await app.request('POST', '/wagering/transactions', refund, headers);

    expect(replay.status).toBe(500);
    expect(replay.body).toMatchObject({
      status: 'FAILED',
      failureCode: 'PROCESSING_FAILED',
      idempotentReplay: true,
      error: { code: 'PROCESSING_FAILED', retryable: false },
    });
  });
});
