import { OptimisticLockError } from '@mikro-orm/core';
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import {
  IntegrityViolationError,
  TransientError,
  UniqueViolationError,
} from '../../../src/application/errors';
import { type UnitOfWork } from '../../../src/application/ports/unit-of-work';
import { WalletBalanceChanged } from '../../../src/domain/messaging/events/wallet-balance-changed';
import { InboxMessage } from '../../../src/domain/messaging/inbox-message';
import { OutboxMessage } from '../../../src/domain/messaging/outbox-message';
import { Money } from '../../../src/domain/money/money';
import { FailureCode } from '../../../src/domain/shared/failure-code';
import { WagerTransactionProcessor } from '../../../src/domain/wagering/wager-transaction-processor';
import { WagerTransactionStatus as Status } from '../../../src/domain/wagering/wager-transaction-status';
import { LedgerDirection } from '../../../src/domain/wallet/ledger-direction';
import { Wallet } from '../../../src/domain/wallet/wallet';
import { MikroOrmUnitOfWork } from '../../../src/infrastructure/persistence/mikro-orm-unit-of-work';
import { brl, HASH, Kind, newTransaction, openWallet, uuid } from '../support/domain-fixtures';
import { captureError, createTestDatabase, type TestDatabase } from '../support/test-database';

let db: TestDatabase;
let uow: UnitOfWork;
const processor = new WagerTransactionProcessor();

beforeAll(async () => {
  db = await createTestDatabase('repositories');
  uow = new MikroOrmUnitOfWork(db.orm);
});

afterAll(async () => {
  await db.close();
});

const createWallet = (balance = '100.00') =>
  uow.run((scope) => Promise.resolve(openWallet(scope, balance)));

/** BET applied exactly as the use case will: lock, process, register everything, commit. */
const placeBet = (walletId: string, amount: string) =>
  uow.run(async (scope) => {
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
    scope.transactions.add(bet);
    if (outcome.status === Status.Processed && outcome.ledgerEntry) {
      scope.wallets.save(wallet);
      scope.ledger.add(outcome.ledgerEntry);
    }
    return { bet, outcome };
  });

const readWallet = (id: string) => uow.run((scope) => scope.wallets.findById(id));

describe('wallet persistence', () => {
  it('opens a wallet with its OPENING transaction and entry atomically', async () => {
    const opened = await createWallet('1000.00');

    const { wallet, page } = await uow.run(async (scope) => ({
      wallet: await scope.wallets.findById(opened.id),
      page: await scope.ledger.listByWallet(opened.id, { limit: 10 }),
    }));

    expect(wallet?.balance.toJSON()).toEqual({ amount: '1000.00', currency: 'BRL' });
    expect(wallet?.version).toBe(1);
    expect(page.entries).toHaveLength(1);
    expect(page.entries[0]?.direction).toBe(LedgerDirection.Credit);
    expect(page.entries[0]?.walletVersion).toBe(1);
  });

  it('opens a zero-balance wallet without any entry', async () => {
    const opened = await createWallet('0.00');

    const page = await uow.run((scope) => scope.ledger.listByWallet(opened.id, { limit: 10 }));

    expect((await readWallet(opened.id))?.balance.isZero()).toBe(true);
    expect(page.entries).toHaveLength(0);
  });

  it('keeps amounts exact across the database round trip', async () => {
    const opened = await createWallet('999999999999999999.99');

    expect((await readWallet(opened.id))?.balance.toJSON().amount).toBe('999999999999999999.99');
  });

  it('finds a wallet by player and currency', async () => {
    const opened = await createWallet();

    const found = await uow.run((scope) =>
      scope.wallets.findByPlayerAndCurrency(opened.playerId, 'BRL'),
    );

    expect(found?.id).toBe(opened.id);
  });

  it('rejects a second wallet for the same player and currency', async () => {
    const opened = await createWallet();
    const { wallet: duplicate } = Wallet.open({
      id: uuid(),
      playerId: opened.playerId,
      initialBalance: Money.zero('BRL'),
      openingTransactionId: uuid(),
      openingEntryId: uuid(),
      at: new Date(),
    });

    const error = await captureError(
      uow.run((scope) => {
        scope.wallets.add(duplicate);
        return Promise.resolve();
      }),
    );

    expect(error).toBeInstanceOf(UniqueViolationError);
    expect((error as UniqueViolationError).constraint).toBe('wallets_player_currency_uq');
  });
});

describe('balance changes', () => {
  it('applies a debit with version, ledger and transaction in one commit', async () => {
    const opened = await createWallet('100.00');

    const { bet } = await placeBet(opened.id, '25.00');

    const { wallet, transaction, page } = await uow.run(async (scope) => ({
      wallet: await scope.wallets.findById(opened.id),
      transaction: await scope.transactions.findById(bet.id),
      page: await scope.ledger.listByWallet(opened.id, { limit: 10 }),
    }));
    expect(wallet?.balance.toJSON().amount).toBe('75.00');
    expect(wallet?.version).toBe(2);
    expect(transaction?.status).toBe(Status.Processed);
    expect(transaction?.observedBalance?.toJSON().amount).toBe('75.00');
    expect(page.entries.map((entry) => entry.walletVersion)).toEqual([1, 2]);
  });

  it('persists a rejection without touching the balance', async () => {
    const opened = await createWallet('20.00');

    const { bet, outcome } = await placeBet(opened.id, '25.00');

    expect(outcome.status).toBe(Status.Rejected);
    const stored = await uow.run((scope) => scope.transactions.findById(bet.id));
    expect(stored?.failureCode).toBe(FailureCode.InsufficientFunds);
    expect((await readWallet(opened.id))?.version).toBe(1);
  });

  it('stores the observed balance in the wallet currency on a currency mismatch', async () => {
    const opened = await createWallet('100.00');

    const transactionId = await uow.run(async (scope) => {
      const wallet = await scope.wallets.findByIdForUpdate(opened.id);
      if (!wallet) throw new Error('wallet not found');
      const usdBet = newTransaction(wallet, Kind.Bet, {
        money: Money.from({ amount: '10.00', currency: 'USD' }),
      });
      processor.process({
        transaction: usdBet,
        wallet,
        reference: undefined,
        referenceAlreadyReversed: false,
        missingReference: { action: 'reject' },
        ledgerEntryId: uuid(),
        at: new Date(),
      });
      scope.transactions.add(usdBet);
      return usdBet.id;
    });

    const stored = await uow.run((scope) => scope.transactions.findById(transactionId));
    expect(stored?.money.currency).toBe('USD');
    expect(stored?.failureCode).toBe(FailureCode.CurrencyMismatch);
    expect(stored?.observedBalance?.toJSON()).toEqual({ amount: '100.00', currency: 'BRL' });
  });

  it('rolls everything back when the unit of work fails', async () => {
    let walletId = '';

    const error = await captureError(
      uow.run((scope) => {
        walletId = openWallet(scope, '50.00').id;
        throw new Error('boom after registering changes');
      }),
    );

    expect(String(error)).toContain('boom');
    expect(walletId).not.toBe('');
    expect(await readWallet(walletId)).toBeUndefined();
  });

  it('is stopped by the database if the ledger entry is forgotten', async () => {
    const opened = await createWallet('100.00');

    const error = await captureError(
      uow.run(async (scope) => {
        const wallet = await scope.wallets.findByIdForUpdate(opened.id);
        if (!wallet) throw new Error('wallet not found');
        wallet.debit(brl('10.00'), { transactionId: uuid(), entryId: uuid(), at: new Date() });
        scope.wallets.save(wallet); // ledger.add deliberately omitted
      }),
    );

    // Raised by the deferred constraint trigger at COMMIT as a raw driver error (SQLSTATE 23514);
    // the unit of work translates it, keeping the original as the cause.
    expect(error).toBeInstanceOf(IntegrityViolationError);
    expect(String((error as IntegrityViolationError).cause)).toContain('no matching ledger entry');
    expect((await readWallet(opened.id))?.balance.toJSON().amount).toBe('100.00');
  });

  it('refuses to save a wallet that was not loaded in the unit of work', async () => {
    const opened = await createWallet('100.00');

    const error = await captureError(
      uow.run((scope) => {
        scope.wallets.save(opened);
        return Promise.resolve();
      }),
    );

    expect(String(error)).toContain('must be loaded in this unit of work');
  });
});

describe('concurrency control', () => {
  it('serializes units of work on the same wallet with FOR UPDATE', async () => {
    const opened = await createWallet('100.00');
    const timeline: string[] = [];

    const debit = (label: string) =>
      uow.run(async (scope) => {
        const wallet = await scope.wallets.findByIdForUpdate(opened.id);
        if (!wallet) throw new Error('wallet not found');
        timeline.push(`${label}:locked@${wallet.balance.toJSON().amount}`);
        await Bun.sleep(200);
        const bet = newTransaction(wallet, Kind.Bet, { money: brl('80.00') });
        const outcome = processor.process({
          transaction: bet,
          wallet,
          reference: undefined,
          referenceAlreadyReversed: false,
          missingReference: { action: 'reject' },
          ledgerEntryId: uuid(),
          at: new Date(),
        });
        scope.transactions.add(bet);
        if (outcome.status === Status.Processed && outcome.ledgerEntry) {
          scope.wallets.save(wallet);
          scope.ledger.add(outcome.ledgerEntry);
        }
        timeline.push(`${label}:${outcome.status}`);
      });

    await Promise.all([debit('A'), debit('B')]);

    // The second unit of work only acquires the lock after the first commits,
    // so it sees 20.00 and is rejected: no lost update, no negative balance.
    const [first, second] = [timeline[0]?.[0], timeline[2]?.[0]];
    expect(timeline).toEqual([
      `${String(first)}:locked@100.00`,
      `${String(first)}:${Status.Processed}`,
      `${String(second)}:locked@20.00`,
      `${String(second)}:${Status.Rejected}`,
    ]);
    expect((await readWallet(opened.id))?.balance.toJSON().amount).toBe('20.00');
  });

  /** Loads the wallet WITHOUT the row lock, lets another unit of work commit, then writes. */
  const staleWrite = (walletId: string, options: { withLedgerEntry: boolean }) =>
    uow.run(async (scope) => {
      const wallet = await scope.wallets.findById(walletId);
      if (!wallet) throw new Error('wallet not found');
      await placeBet(walletId, '30.00'); // concurrent writer commits version 2
      const entry = wallet.debit(brl('10.00'), {
        transactionId: uuid(),
        entryId: uuid(),
        at: new Date(),
      });
      scope.wallets.save(wallet);
      if (options.withLedgerEntry) scope.ledger.add(entry);
    });

  it('rejects a stale write through the ledger version chain', async () => {
    const opened = await createWallet('100.00');

    const error = await captureError(staleWrite(opened.id, { withLedgerEntry: true }));

    // The stale entry claims wallet version 2, which the concurrent writer already used.
    expect(error).toBeInstanceOf(UniqueViolationError);
    expect((error as UniqueViolationError).constraint).toBe('wallet_ledger_entries_version_uq');
    expect((await readWallet(opened.id))?.balance.toJSON().amount).toBe('70.00');
  });

  it('rejects a stale write through the optimistic version check', async () => {
    const opened = await createWallet('100.00');

    const error = await captureError(staleWrite(opened.id, { withLedgerEntry: false }));

    // UPDATE ... WHERE version = 1 matches no row: the ORM raises an optimistic lock error,
    // surfaced as a transient failure (safe to retry with fresh state).
    expect(error).toBeInstanceOf(TransientError);
    expect((error as TransientError).cause).toBeInstanceOf(OptimisticLockError);
    expect((await readWallet(opened.id))?.balance.toJSON().amount).toBe('70.00');
  });
});

describe('transactions and references', () => {
  it('finds a transaction by idempotency key and by external id', async () => {
    const opened = await createWallet();
    const { bet } = await placeBet(opened.id, '10.00');

    const [byKey, byExternal, missing] = await uow.run((scope) =>
      Promise.all([
        scope.transactions.findByIdempotencyKey('provider-a', bet.idempotencyKey),
        scope.transactions.findByExternalId('provider-a', bet.externalTransactionId),
        scope.transactions.findByIdempotencyKey('provider-b', bet.idempotencyKey),
      ]),
    );

    expect(byKey?.id).toBe(bet.id);
    expect(byKey?.matchesPayload(HASH)).toBe(true);
    expect(byExternal?.id).toBe(bet.id);
    expect(missing).toBeUndefined();
  });

  it('persists a pending reference and later resolves it with the reference link', async () => {
    const opened = await createWallet('100.00');
    const { bet } = await placeBet(opened.id, '25.00');

    const refundId = await uow.run(async (scope) => {
      const wallet = await scope.wallets.findByIdForUpdate(opened.id);
      if (!wallet) throw new Error('wallet not found');
      // Names the BET that will be resolved below; the lookup is skipped (reference: undefined)
      // to simulate that it has not arrived yet.
      const refund = newTransaction(wallet, Kind.Refund, {
        referenceExternalTransactionId: bet.externalTransactionId,
      });
      processor.process({
        transaction: refund,
        wallet,
        reference: undefined,
        referenceAlreadyReversed: false,
        missingReference: { action: 'retry', nextAttemptAt: new Date(Date.now() + 1000) },
        ledgerEntryId: uuid(),
        at: new Date(),
      });
      scope.transactions.add(refund);
      return refund.id;
    });

    const pending = await uow.run((scope) => scope.transactions.findById(refundId));
    expect(pending?.status).toBe(Status.PendingReference);
    expect(pending?.attempts).toBe(1);
    expect(pending?.nextAttemptAt).toBeInstanceOf(Date);

    await uow.run(async (scope) => {
      const wallet = await scope.wallets.findByIdForUpdate(opened.id);
      const refund = await scope.transactions.findById(refundId);
      const reference = await scope.transactions.findById(bet.id);
      if (!wallet || !refund || !reference) throw new Error('missing data');
      const outcome = processor.process({
        transaction: refund,
        wallet,
        reference,
        referenceAlreadyReversed: await scope.transactions.hasProcessedReversal(reference.id),
        missingReference: { action: 'reject' },
        ledgerEntryId: uuid(),
        at: new Date(),
      });
      scope.transactions.save(refund);
      if (outcome.status === Status.Processed && outcome.ledgerEntry) {
        scope.wallets.save(wallet);
        scope.ledger.add(outcome.ledgerEntry);
      }
    });

    const [resolved, reversed, wallet] = await uow.run((scope) =>
      Promise.all([
        scope.transactions.findById(refundId),
        scope.transactions.hasProcessedReversal(bet.id),
        scope.wallets.findById(opened.id),
      ]),
    );
    expect(resolved?.status).toBe(Status.Processed);
    expect(resolved?.referenceTransactionId).toBe(bet.id);
    expect(resolved?.nextAttemptAt).toBeUndefined();
    expect(reversed).toBe(true);
    expect(wallet?.balance.toJSON().amount).toBe('100.00');
  });
});

describe('ledger pagination', () => {
  it('pages entries by wallet version with a stable cursor', async () => {
    const opened = await createWallet('100.00');
    for (const amount of ['10.00', '10.00', '10.00', '10.00']) await placeBet(opened.id, amount);

    const first = await uow.run((scope) => scope.ledger.listByWallet(opened.id, { limit: 2 }));
    const second = await uow.run((scope) =>
      scope.ledger.listByWallet(opened.id, { limit: 2, afterVersion: first.nextAfterVersion }),
    );
    const third = await uow.run((scope) =>
      scope.ledger.listByWallet(opened.id, { limit: 2, afterVersion: second.nextAfterVersion }),
    );

    expect(first.entries.map((entry) => entry.walletVersion)).toEqual([1, 2]);
    expect(second.entries.map((entry) => entry.walletVersion)).toEqual([3, 4]);
    expect(third.entries.map((entry) => entry.walletVersion)).toEqual([5]);
    expect(third.nextAfterVersion).toBeUndefined();
  });
});

describe('inbox and outbox', () => {
  it('stores inbox messages and rejects a second one with the same id', async () => {
    const message = InboxMessage.receive({
      messageId: `msg-${uuid()}`,
      consumerName: 'wager-transactions-consumer',
      payloadHash: HASH,
      receivedAt: new Date(),
    });
    message.markProcessed(new Date());
    await uow.run((scope) => {
      scope.inbox.add(message);
      return Promise.resolve();
    });

    const stored = await uow.run((scope) =>
      scope.inbox.find(message.consumerName, message.messageId),
    );
    expect(stored?.isProcessed()).toBe(true);

    const error = await captureError(
      uow.run((scope) => {
        scope.inbox.add(message);
        return Promise.resolve();
      }),
    );
    expect(error).toBeInstanceOf(UniqueViolationError);
    expect((error as UniqueViolationError).constraint).toBe('inbox_messages_pk');
  });

  it('stores the outbox event envelope as jsonb in the same commit as the balance change', async () => {
    const opened = await createWallet('100.00');

    const eventId = await uow.run(async (scope) => {
      const wallet = await scope.wallets.findByIdForUpdate(opened.id);
      if (!wallet) throw new Error('wallet not found');
      const bet = newTransaction(wallet, Kind.Bet);
      const outcome = processor.process({
        transaction: bet,
        wallet,
        reference: undefined,
        referenceAlreadyReversed: false,
        missingReference: { action: 'reject' },
        ledgerEntryId: uuid(),
        at: new Date(),
      });
      if (outcome.status !== Status.Processed || !outcome.ledgerEntry)
        throw new Error('unexpected');
      scope.transactions.add(bet);
      scope.wallets.save(wallet);
      scope.ledger.add(outcome.ledgerEntry);
      const event = WalletBalanceChanged.from(wallet, outcome.ledgerEntry, {
        eventId: uuid(),
        correlationId: uuid(),
        occurredAt: new Date(),
      });
      scope.outbox.add(OutboxMessage.enqueue(event));
      return event.eventId;
    });

    const rows: { event_type: string; payload: { data: { balanceAfter: unknown } } }[] =
      await db.sql.unsafe('select event_type, payload from outbox_messages where id = $1', [
        eventId,
      ]);
    expect(rows[0]?.event_type).toBe('WalletBalanceChanged');
    expect(rows[0]?.payload.data.balanceAfter).toEqual({ amount: '75.00', currency: 'BRL' });
  });
});
