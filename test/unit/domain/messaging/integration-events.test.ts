import { describe, expect, it } from 'bun:test';
import { WagerTransactionPendingReference } from '../../../../src/domain/messaging/events/wager-transaction-pending-reference';
import { WagerTransactionProcessed } from '../../../../src/domain/messaging/events/wager-transaction-processed';
import { WagerTransactionRejected } from '../../../../src/domain/messaging/events/wager-transaction-rejected';
import { WalletBalanceChanged } from '../../../../src/domain/messaging/events/wallet-balance-changed';
import { type EventContext } from '../../../../src/domain/messaging/integration-event';
import { InvalidMessageError } from '../../../../src/domain/messaging/messaging.errors';
import { FailureCode } from '../../../../src/domain/shared/failure-code';
import { LedgerDirection } from '../../../../src/domain/wallet/ledger-direction';
import { Wallet } from '../../../../src/domain/wallet/wallet';
import { AT, Kind, LATER, brl, newTransaction, nextId, openWallet } from '../fixtures';

const ctx = (overrides: Partial<EventContext> = {}): EventContext => ({
  eventId: nextId('event'),
  correlationId: 'corr-1',
  causationId: 'msg-123',
  occurredAt: AT,
  ...overrides,
});

function processedBet() {
  const wallet = openWallet('100.00');
  const bet = newTransaction(Kind.Bet, { money: brl('25.00') });
  const entry = wallet.debit(bet.money, { transactionId: bet.id, entryId: 'entry-1', at: AT });
  bet.markProcessed({ referenceTransactionId: undefined, observedBalance: wallet.balance, at: AT });
  return { wallet, bet, entry };
}

describe('IntegrationEvent envelope', () => {
  it('serializes the full envelope with ISO date, type and version', () => {
    const { bet } = processedBet();
    const context = ctx();

    const envelope = WagerTransactionProcessed.from(bet, context).toJSON();

    expect(envelope).toMatchObject({
      eventId: context.eventId,
      eventType: 'WagerTransactionProcessed',
      aggregateId: bet.id,
      correlationId: 'corr-1',
      causationId: 'msg-123',
      occurredAt: '2026-11-05T12:00:00.000Z',
      version: 1,
    });
  });

  it('omits causationId when there is none', () => {
    const { bet } = processedBet();

    const envelope = WagerTransactionProcessed.from(bet, ctx({ causationId: undefined })).toJSON();

    expect('causationId' in envelope).toBe(false);
  });

  it('carries MoneyProps strings in data, never Money instances', () => {
    const { bet } = processedBet();

    const json = JSON.parse(JSON.stringify(WagerTransactionProcessed.from(bet, ctx()))) as {
      data: { money: unknown; balance: unknown };
    };

    expect(json.data.money).toEqual({ amount: '25.00', currency: 'BRL' });
    expect(json.data.balance).toEqual({ amount: '75.00', currency: 'BRL' });
  });

  it('round-trips through JSON without loss', () => {
    const { bet } = processedBet();
    const envelope = WagerTransactionProcessed.from(bet, ctx()).toJSON();

    expect(JSON.parse(JSON.stringify(envelope))).toEqual(envelope);
  });

  it('freezes data and detaches it from later changes', () => {
    const { bet } = processedBet();
    const event = WagerTransactionProcessed.from(bet, ctx());
    const copy = event.toJSON();
    copy.data.balance.amount = '0.00';

    expect(Object.isFrozen(event.data)).toBe(true);
    expect(event.data.balance.amount).toBe('75.00');
  });

  it('requires a correlation id', () => {
    const { bet } = processedBet();

    expect(() => WagerTransactionProcessed.from(bet, ctx({ correlationId: '' }))).toThrow(
      InvalidMessageError,
    );
  });
});

describe('WagerTransactionProcessed', () => {
  it('is raised for LOSS too, flagging that the balance did not change', () => {
    const loss = newTransaction(Kind.Loss);
    loss.markProcessed({
      referenceTransactionId: undefined,
      observedBalance: brl('100.00'),
      at: AT,
    });

    const event = WagerTransactionProcessed.from(loss, ctx());

    expect(event.data.kind).toBe(Kind.Loss);
    expect(event.data.balanceChanged).toBe(false);
  });

  it('refuses a transaction that is not processed', () => {
    expect(() => WagerTransactionProcessed.from(newTransaction(Kind.Bet), ctx())).toThrow();
  });
});

describe('WagerTransactionRejected', () => {
  it('carries the failure code and the unchanged balance', () => {
    const bet = newTransaction(Kind.Bet);
    bet.reject(FailureCode.InsufficientFunds, { observedBalance: brl('10.00') });

    const event = WagerTransactionRejected.from(bet, ctx());

    expect(event.eventType).toBe('WagerTransactionRejected');
    expect(event.data.failureCode).toBe(FailureCode.InsufficientFunds);
    expect(event.data.balance).toEqual({ amount: '10.00', currency: 'BRL' });
  });

  it('refuses a transaction that is not rejected', () => {
    expect(() => WagerTransactionRejected.from(newTransaction(Kind.Bet), ctx())).toThrow();
  });
});

describe('WagerTransactionPendingReference', () => {
  it('carries the missing reference and the retry schedule', () => {
    const refund = newTransaction(Kind.Refund, { referenceExternalTransactionId: 'bet-later' });
    refund.markPendingReference({ observedBalance: brl('100.00'), nextAttemptAt: LATER });

    const event = WagerTransactionPendingReference.from(refund, ctx());

    expect(event.data).toMatchObject({
      referenceExternalTransactionId: 'bet-later',
      attempts: 1,
      nextAttemptAt: LATER.toISOString(),
    });
  });

  it('refuses a transaction that is not pending a reference', () => {
    expect(() => WagerTransactionPendingReference.from(newTransaction(Kind.Bet), ctx())).toThrow();
  });
});

describe('WalletBalanceChanged', () => {
  it('describes the movement and the new wallet version', () => {
    const { wallet, bet, entry } = processedBet();

    const event = WalletBalanceChanged.from(wallet, entry, ctx());

    expect(event.aggregateId).toBe(wallet.id);
    expect(event.data).toEqual({
      walletId: wallet.id,
      transactionId: bet.id,
      direction: LedgerDirection.Debit,
      money: { amount: '25.00', currency: 'BRL' },
      balanceBefore: { amount: '100.00', currency: 'BRL' },
      balanceAfter: { amount: '75.00', currency: 'BRL' },
      walletVersion: 2,
    });
  });

  it('refuses an entry from another wallet', () => {
    const { entry } = processedBet();
    const { wallet: otherWallet } = Wallet.open({
      id: 'wallet-2',
      playerId: 'player-2',
      initialBalance: brl('100.00'),
      openingTransactionId: 'opening-2',
      openingEntryId: 'entry-2',
      at: AT,
    });

    expect(() => WalletBalanceChanged.from(otherWallet, entry, ctx())).toThrow();
  });
});
