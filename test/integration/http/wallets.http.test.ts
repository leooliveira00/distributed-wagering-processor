import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import {
  type LedgerPageView,
  type WalletView,
} from '../../../src/application/wallets/wallet-views';
import { WagerTransactionProcessor } from '../../../src/domain/wagering/wager-transaction-processor';
import { WagerTransactionStatus } from '../../../src/domain/wagering/wager-transaction-status';
import { MikroOrmUnitOfWork } from '../../../src/infrastructure/persistence/mikro-orm-unit-of-work';
import { type HttpErrorBody } from '../../../src/interfaces/http/errors/http-error-mapping';
import { brl, Kind, newTransaction, uuid } from '../support/domain-fixtures';
import { createTestApp, type TestApp } from '../support/test-app';
import { createTestDatabase, type TestDatabase } from '../support/test-database';

let db: TestDatabase;
let api: TestApp;

beforeAll(async () => {
  db = await createTestDatabase('http_wallets');
  api = await createTestApp(db);
});

afterAll(async () => {
  await api.close();
  await db.close();
});

const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const createWallet = (playerId: string, amount = '1000.00', currency = 'BRL') =>
  api.request('POST', '/wallets', { playerId, initialBalance: { amount, currency } });

const errorCode = (body: unknown) => (body as HttpErrorBody).error.code;

/** Debits the wallet directly through the unit of work (the wagering API comes in stage 5). */
async function debit(walletId: string, amount: string): Promise<void> {
  const unitOfWork = new MikroOrmUnitOfWork(db.orm);
  const processor = new WagerTransactionProcessor();
  await unitOfWork.run(async (scope) => {
    const wallet = await scope.wallets.findByIdForUpdate(walletId);
    if (!wallet) throw new Error('wallet not found');
    const bet = newTransaction(wallet, Kind.Bet, { money: brl(amount) });
    const outcome = processor.process({
      transaction: bet,
      wallet,
      reference: undefined,
      referenceAlreadyReversed: false,
      missingReference: { action: 'reject' },
      ledgerEntryId: uuid(),
      at: new Date(),
    });
    if (outcome.status !== WagerTransactionStatus.Processed || !outcome.ledgerEntry) {
      throw new Error('debit was not processed');
    }
    scope.transactions.add(bet);
    scope.wallets.save(wallet);
    scope.ledger.add(outcome.ledgerEntry);
  });
}

describe('POST /wallets', () => {
  it('creates a wallet with the README response shape and an opening ledger entry', async () => {
    const playerId = uuid();

    const response = await createWallet(playerId, '1000.00');

    expect(response.status).toBe(201);
    const wallet = response.body as WalletView;
    expect(wallet).toMatchObject({
      playerId,
      balance: { amount: '1000.00', currency: 'BRL' },
      version: 1,
    });
    expect(wallet.id).toMatch(UUID_V7);

    const ledger = await api.request('GET', `/wallets/${wallet.id}/ledger`);
    const page = ledger.body as LedgerPageView;
    expect(page.items).toHaveLength(1);
    expect(page.items[0]).toMatchObject({
      direction: 'CREDIT',
      money: { amount: '1000.00', currency: 'BRL' },
      balanceBefore: { amount: '0.00', currency: 'BRL' },
      balanceAfter: { amount: '1000.00', currency: 'BRL' },
      walletVersion: 1,
    });
  });

  it('records the OPENING transaction and its events in the same commit', async () => {
    const wallet = (await createWallet(uuid(), '250.00')).body as WalletView;

    const transactions: { kind: string; status: string; provider_id: string }[] =
      await db.sql.unsafe(
        'select kind, status, provider_id from wager_transactions where wallet_id = $1',
        [wallet.id],
      );
    const events: { event_type: string }[] = await db.sql.unsafe(
      `select o.event_type from outbox_messages o
        where o.aggregate_id = $1
           or o.aggregate_id in (select id::text from wager_transactions where wallet_id = $1::uuid)
        order by o.event_type`,
      [wallet.id],
    );

    expect(transactions).toEqual([
      { kind: 'OPENING', status: 'PROCESSED', provider_id: 'internal' },
    ]);
    expect(events.map((event) => event.event_type)).toEqual([
      'WagerTransactionProcessed',
      'WalletBalanceChanged',
    ]);
  });

  it('creates a zero-balance wallet without ledger entries or events', async () => {
    const wallet = (await createWallet(uuid(), '0.00')).body as WalletView;

    const page = (await api.request('GET', `/wallets/${wallet.id}/ledger`)).body as LedgerPageView;
    const events: unknown[] = await db.sql.unsafe(
      'select 1 from outbox_messages where aggregate_id = $1',
      [wallet.id],
    );

    expect(wallet.version).toBe(1);
    expect(page.items).toEqual([]);
    expect(events).toEqual([]);
  });

  it('rejects a duplicate wallet for the same player and currency with 409', async () => {
    const playerId = uuid();
    await createWallet(playerId);

    const duplicate = await createWallet(playerId);

    expect(duplicate.status).toBe(409);
    expect(errorCode(duplicate.body)).toBe('WALLET_ALREADY_EXISTS');
  });

  it('allows the same player to own a wallet in another currency', async () => {
    const playerId = uuid();
    await createWallet(playerId, '10.00', 'BRL');

    expect((await createWallet(playerId, '10.00', 'USD')).status).toBe(201);
  });

  it('creates exactly one wallet under 10 concurrent requests for the same player', async () => {
    const playerId = uuid();

    const responses = await Promise.all(
      Array.from({ length: 10 }, () => createWallet(playerId, '100.00')),
    );

    const statuses = responses.map((response) => response.status).sort();
    expect(statuses).toEqual([201, 409, 409, 409, 409, 409, 409, 409, 409, 409]);
    // Losers of the race must get the same business code as a sequential duplicate.
    const conflictCodes = responses
      .filter((response) => response.status === 409)
      .map((response) => errorCode(response.body));
    expect(new Set(conflictCodes)).toEqual(new Set(['WALLET_ALREADY_EXISTS']));
    const rows: unknown[] = await db.sql.unsafe('select 1 from wallets where player_id = $1', [
      playerId,
    ]);
    expect(rows).toHaveLength(1);
  });

  it.each([
    [
      'missing playerId',
      { initialBalance: { amount: '1.00', currency: 'BRL' } },
      'INVALID_PAYLOAD',
    ],
    [
      'non-UUID playerId',
      { playerId: 'player-1', initialBalance: { amount: '1.00', currency: 'BRL' } },
      'INVALID_PAYLOAD',
    ],
    [
      'numeric amount',
      { playerId: 'UUID', initialBalance: { amount: 25, currency: 'BRL' } },
      'INVALID_PAYLOAD',
    ],
    [
      'unknown field',
      { playerId: 'UUID', initialBalance: { amount: '1.00', currency: 'BRL' }, extra: 1 },
      'INVALID_PAYLOAD',
    ],
    [
      'amount with one decimal',
      { playerId: 'UUID', initialBalance: { amount: '25.5', currency: 'BRL' } },
      'INVALID_MONEY',
    ],
    [
      'negative amount',
      { playerId: 'UUID', initialBalance: { amount: '-1.00', currency: 'BRL' } },
      'INVALID_MONEY',
    ],
    [
      'scientific notation',
      { playerId: 'UUID', initialBalance: { amount: '1e3', currency: 'BRL' } },
      'INVALID_MONEY',
    ],
    [
      'lowercase currency',
      { playerId: 'UUID', initialBalance: { amount: '1.00', currency: 'brl' } },
      'INVALID_MONEY',
    ],
  ])('rejects %s with 400', async (_, payload, code) => {
    const body = JSON.parse(JSON.stringify(payload).replace('"UUID"', `"${uuid()}"`)) as unknown;

    const response = await api.request('POST', '/wallets', body);

    expect(response.status).toBe(400);
    expect(errorCode(response.body)).toBe(code);
    expect((response.body as HttpErrorBody).error.retryable).toBe(false);
  });

  it('lists every contract violation at once', async () => {
    const response = await api.request('POST', '/wallets', { playerId: 'x', initialBalance: {} });

    const issues = (response.body as HttpErrorBody).error.issues ?? [];
    expect(issues.map((issue) => issue.path).sort()).toEqual([
      'initialBalance.amount',
      'initialBalance.currency',
      'playerId',
    ]);
  });
});

describe('GET /wallets/:walletId', () => {
  it('returns the current wallet state', async () => {
    const created = (await createWallet(uuid(), '80.00')).body as WalletView;
    await debit(created.id, '30.00');

    const response = await api.request('GET', `/wallets/${created.id}`);

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      id: created.id,
      balance: { amount: '50.00', currency: 'BRL' },
      version: 2,
    });
  });

  it('answers 404 for an unknown wallet', async () => {
    const response = await api.request('GET', `/wallets/${uuid()}`);

    expect(response.status).toBe(404);
    expect(errorCode(response.body)).toBe('WALLET_NOT_FOUND');
  });

  it('answers 400 for a malformed wallet id', async () => {
    const response = await api.request('GET', '/wallets/not-a-uuid');

    expect(response.status).toBe(400);
    expect(errorCode(response.body)).toBe('INVALID_PAYLOAD');
  });
});

describe('GET /wallets/:walletId/ledger', () => {
  it('pages through every entry exactly once with an opaque cursor', async () => {
    const wallet = (await createWallet(uuid(), '100.00')).body as WalletView;
    for (const amount of ['10.00', '10.00', '10.00', '10.00']) await debit(wallet.id, amount);

    const versions: number[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const query: string = cursor === null ? '?limit=2' : `?limit=2&cursor=${cursor}`;
      const response = await api.request('GET', `/wallets/${wallet.id}/ledger${query}`);
      expect(response.status).toBe(200);
      const page = response.body as LedgerPageView;
      versions.push(...page.items.map((item) => item.walletVersion));
      cursor = page.nextCursor;
      pages++;
    } while (cursor !== null && pages < 10);

    expect(versions).toEqual([1, 2, 3, 4, 5]);
    expect(pages).toBe(3);
  });

  it('keeps the cursor stable while new entries are appended', async () => {
    const wallet = (await createWallet(uuid(), '100.00')).body as WalletView;
    await debit(wallet.id, '10.00');
    const first = (await api.request('GET', `/wallets/${wallet.id}/ledger?limit=1`))
      .body as LedgerPageView;

    await debit(wallet.id, '10.00'); // appended between page requests
    const second = (
      await api.request(
        'GET',
        `/wallets/${wallet.id}/ledger?limit=10&cursor=${String(first.nextCursor)}`,
      )
    ).body as LedgerPageView;

    expect(first.items.map((item) => item.walletVersion)).toEqual([1]);
    expect(second.items.map((item) => item.walletVersion)).toEqual([2, 3]);
  });

  it.each([
    ['a tampered cursor', '?cursor=bm90LWEtY3Vyc29y', 'INVALID_CURSOR'],
    ['limit zero', '?limit=0', 'INVALID_PAYLOAD'],
    ['limit above the maximum', '?limit=101', 'INVALID_PAYLOAD'],
    ['a non-numeric limit', '?limit=abc', 'INVALID_PAYLOAD'],
  ])('rejects %s with 400', async (_, query, code) => {
    const wallet = (await createWallet(uuid(), '10.00')).body as WalletView;

    const response = await api.request('GET', `/wallets/${wallet.id}/ledger${query}`);

    expect(response.status).toBe(400);
    expect(errorCode(response.body)).toBe(code);
  });

  it('answers 404 for an unknown wallet', async () => {
    const response = await api.request('GET', `/wallets/${uuid()}/ledger`);

    expect(response.status).toBe(404);
  });
});
