import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import {
  type WagerSubmissionResult,
  type WagerTransactionView,
} from '../../../src/application/wagering/wager-views';
import { type WalletView } from '../../../src/application/wallets/wallet-views';
import { type HttpErrorBody } from '../../../src/interfaces/http/errors/http-error-mapping';
import { uuid } from '../support/domain-fixtures';
import { expectLedgerConsistent } from '../support/invariants';
import { createTestApp, type TestApp } from '../support/test-app';
import { createTestDatabase, type TestDatabase } from '../support/test-database';

let db: TestDatabase;
let api: TestApp;

beforeAll(async () => {
  db = await createTestDatabase('http_wagering');
  api = await createTestApp(db);
});

afterAll(async () => {
  await api.close();
  await db.close();
});

type Body = Record<string, unknown>;
type RejectedBody = WagerSubmissionResult & HttpErrorBody;

async function openWallet(amount = '1000.00'): Promise<WalletView> {
  const response = await api.request('POST', '/wallets', {
    playerId: uuid(),
    initialBalance: { amount, currency: 'BRL' },
  });
  return response.body as WalletView;
}

/** README §9 request, bound to a wallet; every call gets a fresh external id unless overridden. */
function wager(wallet: WalletView, overrides: Body = {}): Body {
  return {
    providerId: 'provider-a',
    externalTransactionId: `tx-${uuid()}`,
    playerId: wallet.playerId,
    walletId: wallet.id,
    roundId: 'round-987',
    gameId: 'fortune-chimp',
    kind: 'BET',
    money: { amount: '25.00', currency: 'BRL' },
    ...overrides,
  };
}

function submit(body: Body, idempotencyKey?: string) {
  const key = idempotencyKey ?? `${String(body.providerId)}:${String(body.externalTransactionId)}`;
  return api.request('POST', '/wagering/transactions', body, { 'Idempotency-Key': key });
}

const reversal = (wallet: WalletView, kind: string, reference: Body, overrides: Body = {}) =>
  wager(wallet, {
    kind,
    money: reference.money,
    referenceExternalTransactionId: reference.externalTransactionId,
    ...overrides,
  });

describe('POST /wagering/transactions — applied operations', () => {
  it('processes the README BET example: 201 with the documented response shape', async () => {
    const wallet = await openWallet('1000.00');

    const response = await submit(wager(wallet));

    expect(response.status).toBe(201);
    expect(response.body).toEqual({
      transactionId: (response.body as WagerSubmissionResult).transactionId,
      status: 'PROCESSED',
      balance: { amount: '975.00', currency: 'BRL' },
      idempotentReplay: false,
      failureCode: null,
    });
    await expectLedgerConsistent(db.sql, wallet.id);
  });

  it('applies WIN (credit), LOSS (no movement), REFUND and ROLLBACK end to end', async () => {
    const wallet = await openWallet('100.00');
    const bet = wager(wallet, { money: { amount: '40.00', currency: 'BRL' } });
    const win = wager(wallet, {
      kind: 'WIN',
      money: { amount: '15.00', currency: 'BRL' },
      referenceExternalTransactionId: bet.externalTransactionId,
    });

    const balances = [];
    for (const operation of [
      bet, // 60.00
      win, // 75.00
      wager(wallet, { kind: 'LOSS' }), // 75.00, no ledger entry
      reversal(wallet, 'ROLLBACK', win), // 60.00 (inverse of WIN)
      reversal(wallet, 'REFUND', bet), // 100.00
    ]) {
      const response = await submit(operation);
      expect(response.status).toBe(201);
      balances.push((response.body as WagerSubmissionResult).balance?.amount);
    }

    expect(balances).toEqual(['60.00', '75.00', '75.00', '60.00', '100.00']);
    const ledger = await api.request('GET', `/wallets/${wallet.id}/ledger`);
    expect((ledger.body as { items: unknown[] }).items).toHaveLength(5); // opening + 4 movements
    await expectLedgerConsistent(db.sql, wallet.id);
  });
});

describe('POST /wagering/transactions — idempotency', () => {
  it('replays an identical request with the same status and body', async () => {
    const wallet = await openWallet();
    const body = wager(wallet);
    const first = await submit(body);

    const replay = await submit(body);

    expect(replay.status).toBe(201);
    expect(replay.body).toEqual({
      ...(first.body as WagerSubmissionResult),
      idempotentReplay: true,
    });
    await expectLedgerConsistent(db.sql, wallet.id);
  });

  it('answers 409 when the key is reused with a different payload', async () => {
    const wallet = await openWallet();
    const body = wager(wallet);
    await submit(body);

    const conflict = await submit({ ...body, money: { amount: '99.00', currency: 'BRL' } });

    expect(conflict.status).toBe(409);
    expect((conflict.body as HttpErrorBody).error).toMatchObject({
      code: 'IDEMPOTENCY_KEY_CONFLICT',
      retryable: false,
    });
  });

  it('answers 409 when the same provider transaction comes with another key', async () => {
    const wallet = await openWallet();
    const body = wager(wallet);
    await submit(body);

    const conflict = await submit(body, 'a-different-key');

    expect(conflict.status).toBe(409);
    expect((conflict.body as HttpErrorBody).error.code).toBe('EXTERNAL_TRANSACTION_CONFLICT');
  });

  it.each([
    ['missing', undefined],
    ['with spaces', 'has spaces'],
    ['too long', 'k'.repeat(256)],
  ])('requires a valid Idempotency-Key header (%s)', async (_, key) => {
    const wallet = await openWallet();

    const response =
      key === undefined
        ? await api.request('POST', '/wagering/transactions', wager(wallet))
        : await submit(wager(wallet), key);

    expect(response.status).toBe(400);
    expect((response.body as HttpErrorBody).error.code).toBe('INVALID_IDEMPOTENCY_KEY');
  });
});

describe('POST /wagering/transactions — business rejections (422)', () => {
  async function expectRejected(body: Body, failureCode: string, walletId: string) {
    const response = await submit(body);

    expect(response.status).toBe(422);
    const rejected = response.body as RejectedBody;
    expect(rejected).toMatchObject({ status: 'REJECTED', failureCode, idempotentReplay: false });
    expect(rejected.transactionId).toBeString();
    // Uniform error envelope, same as every other 4xx/5xx.
    expect(rejected.error).toMatchObject({ code: failureCode, retryable: false });
    expect(rejected.error.message.length).toBeGreaterThan(0);
    await expectLedgerConsistent(db.sql, walletId);
    return { body, rejected };
  }

  it('INSUFFICIENT_FUNDS for a BET above the balance', async () => {
    const wallet = await openWallet('10.00');

    await expectRejected(wager(wallet), 'INSUFFICIENT_FUNDS', wallet.id);
  });

  it('REVERSAL_INSUFFICIENT_FUNDS, a distinct code, for a reversal that would go negative', async () => {
    const wallet = await openWallet('10.00');
    const win = wager(wallet, { kind: 'WIN', money: { amount: '50.00', currency: 'BRL' } });
    await submit(win);
    await submit(wager(wallet, { money: { amount: '55.00', currency: 'BRL' } })); // 60 -> 5

    await expectRejected(
      reversal(wallet, 'ROLLBACK', win),
      'REVERSAL_INSUFFICIENT_FUNDS',
      wallet.id,
    );
  });

  it('PLAYER_WALLET_MISMATCH when the player does not own the wallet', async () => {
    const wallet = await openWallet();

    await expectRejected(wager(wallet, { playerId: uuid() }), 'PLAYER_WALLET_MISMATCH', wallet.id);
  });

  it('CURRENCY_MISMATCH when the currency differs from the wallet', async () => {
    const wallet = await openWallet();
    const { rejected } = await expectRejected(
      wager(wallet, { money: { amount: '5.00', currency: 'USD' } }),
      'CURRENCY_MISMATCH',
      wallet.id,
    );

    expect(rejected.balance).toEqual({ amount: '1000.00', currency: 'BRL' });
  });

  it('REFERENCE_KIND_NOT_ALLOWED for a REFUND of a WIN', async () => {
    const wallet = await openWallet();
    const win = wager(wallet, { kind: 'WIN' });
    await submit(win);

    await expectRejected(reversal(wallet, 'REFUND', win), 'REFERENCE_KIND_NOT_ALLOWED', wallet.id);
  });

  it('REFERENCE_CONTEXT_MISMATCH for a reference from another round', async () => {
    const wallet = await openWallet();
    const bet = wager(wallet);
    await submit(bet);

    await expectRejected(
      reversal(wallet, 'REFUND', bet, { roundId: 'another-round' }),
      'REFERENCE_CONTEXT_MISMATCH',
      wallet.id,
    );
  });

  it('REFERENCE_AMOUNT_MISMATCH for a partial reversal', async () => {
    const wallet = await openWallet();
    const bet = wager(wallet);
    await submit(bet);

    await expectRejected(
      reversal(wallet, 'REFUND', bet, { money: { amount: '10.00', currency: 'BRL' } }),
      'REFERENCE_AMOUNT_MISMATCH',
      wallet.id,
    );
  });

  it('REFERENCE_ALREADY_REVERSED for a ROLLBACK of a refunded BET (D6)', async () => {
    const wallet = await openWallet();
    const bet = wager(wallet);
    await submit(bet);
    await submit(reversal(wallet, 'REFUND', bet));

    await expectRejected(
      reversal(wallet, 'ROLLBACK', bet),
      'REFERENCE_ALREADY_REVERSED',
      wallet.id,
    );
  });

  it('REFERENCE_NOT_PROCESSED for a reversal of a rejected BET', async () => {
    const wallet = await openWallet('10.00');
    const bet = wager(wallet); // rejected: insufficient funds
    await submit(bet);

    await expectRejected(reversal(wallet, 'REFUND', bet), 'REFERENCE_NOT_PROCESSED', wallet.id);
  });

  it('replays a rejection with the same 422 body', async () => {
    const wallet = await openWallet('10.00');
    const { body, rejected } = await expectRejected(wager(wallet), 'INSUFFICIENT_FUNDS', wallet.id);

    const replay = await submit(body);

    expect(replay.status).toBe(422);
    expect(replay.body).toEqual({ ...rejected, idempotentReplay: true });
  });
});

describe('POST /wagering/transactions — pending reference (202)', () => {
  it('accepts a REFUND before its BET and keeps it pending for the worker', async () => {
    const wallet = await openWallet('100.00');
    const bet = wager(wallet);
    const refund = reversal(wallet, 'REFUND', bet);

    const accepted = await submit(refund);
    const replay = await submit(refund);
    const betResponse = await submit(bet);

    expect(accepted.status).toBe(202);
    expect(accepted.body).toMatchObject({ status: 'PENDING_REFERENCE', failureCode: null });
    expect(replay.status).toBe(202);
    expect(betResponse.status).toBe(201);
    const view = (
      await api.request(
        'GET',
        `/wagering/transactions/${(accepted.body as WagerSubmissionResult).transactionId}`,
      )
    ).body as WagerTransactionView;
    expect(view).toMatchObject({ status: 'PENDING_REFERENCE', attempts: 1 });
    expect(view.nextAttemptAt).toBeString();
    await expectLedgerConsistent(db.sql, wallet.id);
  });
});

describe('POST /wagering/transactions — contract violations (400/404)', () => {
  it.each([
    ['OPENING submitted from outside', { kind: 'OPENING' }, 'UNSUPPORTED_KIND'],
    ['unknown kind', { kind: 'JACKPOT' }, 'INVALID_PAYLOAD'],
    ['REFUND without reference', { kind: 'REFUND' }, 'REFERENCE_REQUIRED'],
    ['BET with a reference', { referenceExternalTransactionId: 'x' }, 'REFERENCE_NOT_ALLOWED'],
    ['amount with one decimal', { money: { amount: '25.5', currency: 'BRL' } }, 'INVALID_MONEY'],
    ['numeric amount', { money: { amount: 25, currency: 'BRL' } }, 'INVALID_PAYLOAD'],
    ['zero amount', { money: { amount: '0.00', currency: 'BRL' } }, 'NON_POSITIVE_AMOUNT'],
    ['reserved internal provider', { providerId: 'internal' }, 'RESERVED_PROVIDER'],
    ['malformed wallet id', { walletId: 'wallet-1' }, 'INVALID_PAYLOAD'],
    ['unknown field', { extra: true }, 'INVALID_PAYLOAD'],
  ])('rejects %s with 400', async (_, overrides, code) => {
    const wallet = await openWallet();

    const response = await submit(wager(wallet, overrides));

    expect(response.status).toBe(400);
    expect((response.body as HttpErrorBody).error).toMatchObject({ code, retryable: false });
    await expectLedgerConsistent(db.sql, wallet.id);
  });

  it('answers 404 for an unknown wallet', async () => {
    const wallet = await openWallet();

    const response = await submit(wager(wallet, { walletId: uuid() }));

    expect(response.status).toBe(404);
    expect((response.body as HttpErrorBody).error.code).toBe('WALLET_NOT_FOUND');
  });
});

describe('transaction queries', () => {
  it('finds a transaction by internal id and by provider external id', async () => {
    const wallet = await openWallet();
    const body = wager(wallet);
    const submitted = (await submit(body)).body as WagerSubmissionResult;

    const byId = await api.request('GET', `/wagering/transactions/${submitted.transactionId}`);
    const byExternal = await api.request(
      'GET',
      `/providers/provider-a/wagering/transactions/${String(body.externalTransactionId)}`,
    );

    expect(byId.status).toBe(200);
    expect(byId.body).toMatchObject({
      transactionId: submitted.transactionId,
      kind: 'BET',
      status: 'PROCESSED',
      money: { amount: '25.00', currency: 'BRL' },
      balance: { amount: '975.00', currency: 'BRL' },
    });
    expect(byExternal.body).toEqual(byId.body);
  });

  it('answers 404 for unknown transactions and 400 for a malformed id', async () => {
    const unknownId = await api.request('GET', `/wagering/transactions/${uuid()}`);
    const unknownExternal = await api.request(
      'GET',
      '/providers/provider-a/wagering/transactions/nope',
    );
    const malformed = await api.request('GET', '/wagering/transactions/not-a-uuid');

    expect(unknownId.status).toBe(404);
    expect((unknownId.body as HttpErrorBody).error.code).toBe('TRANSACTION_NOT_FOUND');
    expect(unknownExternal.status).toBe(404);
    expect(malformed.status).toBe(400);
  });
});
