import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { APP_LOGGER, type AppLogger, type LogFields } from '../../../src/application/ports/logger';
import { METRICS } from '../../../src/application/ports/metrics';
import { type ReconciliationView } from '../../../src/application/wallets/reconcile-wallet';
import { type WalletView } from '../../../src/application/wallets/wallet-views';
import { WagerTransactionProcessor } from '../../../src/domain/wagering/wager-transaction-processor';
import { WagerTransactionStatus } from '../../../src/domain/wagering/wager-transaction-status';
import { type PrometheusMetrics } from '../../../src/infrastructure/observability/prometheus-metrics';
import { MikroOrmUnitOfWork } from '../../../src/infrastructure/persistence/mikro-orm-unit-of-work';
import { type HttpErrorBody } from '../../../src/interfaces/http/errors/http-error-mapping';
import { brl, Kind, newTransaction, uuid } from '../support/domain-fixtures';
import { expectLedgerConsistent } from '../support/invariants';
import { createTestApp, type TestApp } from '../support/test-app';
import { createTestDatabase, type TestDatabase } from '../support/test-database';

interface LogLine {
  level: 'info' | 'warn' | 'error';
  message: string;
  fields: LogFields;
}

/** Records log lines so the test can assert the divergence is logged. */
class RecordingLogger implements AppLogger {
  readonly lines: LogLine[] = [];

  get warnings(): LogLine[] {
    return this.lines.filter((line) => line.level === 'warn');
  }

  info(message: string, fields: LogFields = {}): void {
    this.lines.push({ level: 'info', message, fields });
  }

  warn(message: string, fields: LogFields = {}): void {
    this.lines.push({ level: 'warn', message, fields });
  }

  error(message: string, fields: LogFields = {}): void {
    this.lines.push({ level: 'error', message, fields });
  }
}

let db: TestDatabase;
let api: TestApp;
let metrics: PrometheusMetrics;
const logger = new RecordingLogger();

beforeAll(async () => {
  db = await createTestDatabase('http_reconciliation');
  api = await createTestApp(db, [{ token: APP_LOGGER, value: logger }]);
  metrics = api.app.get(METRICS);
});

afterAll(async () => {
  await api.close();
  await db.close();
});

beforeEach(() => {
  logger.lines.length = 0;
});

const createWallet = async (amount: string): Promise<WalletView> =>
  (
    await api.request('POST', '/wallets', {
      playerId: uuid(),
      initialBalance: { amount, currency: 'BRL' },
    })
  ).body as WalletView;

const reconcile = (walletId: string) => api.request('POST', `/wallets/${walletId}/reconciliation`);

async function debit(walletId: string, amount: string): Promise<void> {
  const unitOfWork = new MikroOrmUnitOfWork(db.orm);
  await unitOfWork.run(async (scope) => {
    const wallet = await scope.wallets.findByIdForUpdate(walletId);
    if (!wallet) throw new Error('wallet not found');
    const bet = newTransaction(wallet, Kind.Bet, { money: brl(amount) });
    const outcome = new WagerTransactionProcessor().process({
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

/** Bypasses every guard to simulate corruption: triggers off, balance changed, triggers on. */
async function tamperBalance(walletId: string, newBalance: string): Promise<void> {
  await db.sql.begin(async (tx) => {
    await tx.unsafe('alter table wallets disable trigger user');
    await tx.unsafe('update wallets set balance = $1 where id = $2', [newBalance, walletId]);
    await tx.unsafe('alter table wallets enable trigger user');
  });
}

describe('POST /wallets/:walletId/reconciliation', () => {
  it('reports a consistent wallet in the README response shape', async () => {
    const wallet = await createWallet('1000.00');
    await debit(wallet.id, '25.00');
    const before = await metrics.counterValue('wallet_reconciliations_total', {
      result: 'consistent',
    });

    const response = await reconcile(wallet.id);

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      walletId: wallet.id,
      storedBalance: { amount: '975.00', currency: 'BRL' },
      calculatedBalance: { amount: '975.00', currency: 'BRL' },
      difference: { amount: '0.00', currency: 'BRL' },
      consistent: true,
      checkedEntries: 2,
    } satisfies ReconciliationView);
    expect(
      await metrics.counterValue('wallet_reconciliations_total', { result: 'consistent' }),
    ).toBe(before + 1);
    expect(logger.warnings).toHaveLength(0);
    await expectLedgerConsistent(db.sql, wallet.id);
  });

  it('handles a wallet without ledger entries', async () => {
    const wallet = await createWallet('0.00');

    const result = (await reconcile(wallet.id)).body as ReconciliationView;

    expect(result).toMatchObject({ consistent: true, checkedEntries: 0 });
    expect(result.calculatedBalance).toEqual({ amount: '0.00', currency: 'BRL' });
  });

  it('flags, logs and counts a divergence without correcting it', async () => {
    const wallet = await createWallet('100.00');
    await debit(wallet.id, '20.00');
    await tamperBalance(wallet.id, '85.00');
    const divergencesBefore = await metrics.counterValue('wallet_reconciliation_divergences_total');

    const response = await reconcile(wallet.id);

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      walletId: wallet.id,
      storedBalance: { amount: '85.00', currency: 'BRL' },
      calculatedBalance: { amount: '80.00', currency: 'BRL' },
      difference: { amount: '5.00', currency: 'BRL' },
      consistent: false,
      checkedEntries: 2,
    } satisfies ReconciliationView);
    expect(await metrics.counterValue('wallet_reconciliation_divergences_total')).toBe(
      divergencesBefore + 1,
    );
    expect(logger.warnings).toHaveLength(1);
    expect(logger.warnings[0]?.message).toBe('Wallet balance diverges from its ledger');
    expect(logger.warnings[0]?.fields).toMatchObject({
      walletId: wallet.id,
      difference: '5.00',
      checkedEntries: 2,
    });
    // Not silently corrected: the stored balance is still the divergent one.
    const current = (await api.request('GET', `/wallets/${wallet.id}`)).body as WalletView;
    expect(current.balance.amount).toBe('85.00');
  });

  it('reports a negative difference when the stored balance is below the ledger', async () => {
    const wallet = await createWallet('100.00');
    await tamperBalance(wallet.id, '95.00');

    const result = (await reconcile(wallet.id)).body as ReconciliationView;

    expect(result.consistent).toBe(false);
    expect(result.difference).toEqual({ amount: '-5.00', currency: 'BRL' });
  });

  it('never reports a false divergence while the wallet is being written concurrently', async () => {
    const wallet = await createWallet('1000.00');

    const writes = Array.from({ length: 20 }, () => debit(wallet.id, '1.00'));
    const checks = Array.from({ length: 20 }, () => reconcile(wallet.id));
    const [, responses] = await Promise.all([Promise.all(writes), Promise.all(checks)]);

    const results = responses.map((response) => response.body as ReconciliationView);
    expect(results.filter((result) => !result.consistent)).toEqual([]);
    await expectLedgerConsistent(db.sql, wallet.id);
    expect(((await reconcile(wallet.id)).body as ReconciliationView).checkedEntries).toBe(21);
  });

  it('answers 404 for an unknown wallet and 400 for a malformed id', async () => {
    const unknown = await reconcile(uuid());
    const malformed = await reconcile('nope');

    expect(unknown.status).toBe(404);
    expect((unknown.body as HttpErrorBody).error.code).toBe('WALLET_NOT_FOUND');
    expect(malformed.status).toBe(400);
  });
});
