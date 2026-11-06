import { describe, expect, it } from 'bun:test';
import { Money } from '../../../../src/domain/money/money';
import { CurrencyMismatchError } from '../../../../src/domain/money/money.errors';
import { LedgerDirection } from '../../../../src/domain/wallet/ledger-direction';
import { Wallet } from '../../../../src/domain/wallet/wallet';
import { type WalletLedgerEntry } from '../../../../src/domain/wallet/wallet-ledger-entry';
import {
  InsufficientFundsError,
  InvalidWalletError,
} from '../../../../src/domain/wallet/wallet.errors';
import { AT, LATER, brl, nextId, openWallet, usd } from '../fixtures';

const movement = (at = LATER) => ({ transactionId: nextId('tx'), entryId: nextId('entry'), at });

/** Rebuilds the balance from ledger entries only: the final invariant of README §13. */
const balanceFromLedger = (entries: WalletLedgerEntry[], currency = 'BRL'): Money =>
  entries.reduce(
    (total, entry) =>
      entry.direction === LedgerDirection.Credit
        ? total.add(entry.money)
        : total.subtract(entry.money),
    Money.zero(currency),
  );

describe('Wallet.open', () => {
  it('starts at version 1 with an opening CREDIT for a positive initial balance', () => {
    const { wallet, openingEntry } = Wallet.open({
      id: 'wallet-1',
      playerId: 'player-1',
      initialBalance: brl('1000.00'),
      openingTransactionId: 'opening-tx',
      openingEntryId: 'opening-entry',
      at: AT,
    });

    expect(wallet.balance.toJSON()).toEqual({ amount: '1000.00', currency: 'BRL' });
    expect(wallet.currency).toBe('BRL');
    expect(wallet.version).toBe(1);
    expect(openingEntry).toMatchObject({
      id: 'opening-entry',
      transactionId: 'opening-tx',
      direction: LedgerDirection.Credit,
    });
    expect(openingEntry?.balanceBefore.isZero()).toBe(true);
    expect(openingEntry?.balanceAfter.equals(brl('1000.00'))).toBe(true);
  });

  it('creates no ledger entry for a zero initial balance', () => {
    const { wallet, openingEntry } = Wallet.open({
      id: 'wallet-1',
      playerId: 'player-1',
      initialBalance: Money.zero('BRL'),
      openingTransactionId: 'opening-tx',
      openingEntryId: 'opening-entry',
      at: AT,
    });

    expect(wallet.version).toBe(1);
    expect(openingEntry).toBeUndefined();
  });

  it('rejects a negative initial balance', () => {
    expect(() =>
      Wallet.open({
        id: 'wallet-1',
        playerId: 'player-1',
        initialBalance: brl('1.00').negate(),
        openingTransactionId: 'opening-tx',
        openingEntryId: 'opening-entry',
        at: AT,
      }),
    ).toThrow(InvalidWalletError);
  });

  it('requires identifiers', () => {
    expect(() =>
      Wallet.open({
        id: '',
        playerId: 'player-1',
        initialBalance: brl('1.00'),
        openingTransactionId: 'opening-tx',
        openingEntryId: 'opening-entry',
        at: AT,
      }),
    ).toThrow(InvalidWalletError);
  });
});

describe('Wallet.debit / credit', () => {
  it('debits, bumps version and returns the matching DEBIT entry', () => {
    const wallet = openWallet('100.00');
    const entry = wallet.debit(brl('30.00'), movement());

    expect(wallet.balance.equals(brl('70.00'))).toBe(true);
    expect(wallet.version).toBe(2);
    expect(wallet.updatedAt).toEqual(LATER);
    expect(entry.direction).toBe(LedgerDirection.Debit);
    expect(entry.balanceBefore.equals(brl('100.00'))).toBe(true);
    expect(entry.balanceAfter.equals(brl('70.00'))).toBe(true);
  });

  it('credits, bumps version and returns the matching CREDIT entry', () => {
    const wallet = openWallet('100.00');
    const entry = wallet.credit(brl('0.01'), movement());

    expect(wallet.balance.equals(brl('100.01'))).toBe(true);
    expect(wallet.version).toBe(2);
    expect(entry.direction).toBe(LedgerDirection.Credit);
  });

  it('allows debiting the whole balance down to zero', () => {
    const wallet = openWallet('80.00');
    wallet.debit(brl('80.00'), movement());

    expect(wallet.balance.isZero()).toBe(true);
  });

  it('never goes negative: insufficient funds throws and leaves state untouched', () => {
    const wallet = openWallet('79.99');

    expect(() => wallet.debit(brl('80.00'), movement())).toThrow(InsufficientFundsError);
    expect(wallet.balance.equals(brl('79.99'))).toBe(true);
    expect(wallet.version).toBe(1);
    expect(wallet.updatedAt).toEqual(AT);
  });

  it.each([
    ['debit', (wallet: Wallet) => wallet.debit(usd('1.00'), movement())],
    ['credit', (wallet: Wallet) => wallet.credit(usd('1.00'), movement())],
    ['canDebit', (wallet: Wallet) => wallet.canDebit(usd('1.00'))],
  ])('%s rejects a different currency without changing state', (_, operation) => {
    const wallet = openWallet('100.00');

    expect(() => operation(wallet)).toThrow(CurrencyMismatchError);
    expect(wallet.balance.equals(brl('100.00'))).toBe(true);
    expect(wallet.version).toBe(1);
  });

  it('changes version only when the balance changes', () => {
    const wallet = openWallet('100.00');
    wallet.canDebit(brl('500.00'));
    expect(() => wallet.debit(brl('500.00'), movement())).toThrow(InsufficientFundsError);

    expect(wallet.version).toBe(1);
  });

  it('keeps balance and ledger consistent across a sequence of movements', () => {
    const { wallet, openingEntry } = Wallet.open({
      id: 'wallet-1',
      playerId: 'player-1',
      initialBalance: brl('100.00'),
      openingTransactionId: 'opening-tx',
      openingEntryId: 'opening-entry',
      at: AT,
    });
    if (!openingEntry) throw new Error('expected an opening entry');
    const movements = [
      wallet.debit(brl('25.00'), movement()),
      wallet.credit(brl('50.00'), movement()),
      wallet.debit(brl('125.00'), movement()),
      wallet.credit(brl('0.10'), movement()),
    ];
    const entries = [openingEntry, ...movements];

    expect(wallet.balance.toJSON().amount).toBe('0.10');
    expect(balanceFromLedger(entries).equals(wallet.balance)).toBe(true);
    // Each entry starts exactly where the previous one ended: the ledger is a continuous chain.
    entries.reduce((previous, current) => {
      expect(current.balanceBefore.equals(previous.balanceAfter)).toBe(true);
      return current;
    });
    expect(wallet.version).toBe(1 + movements.length);
    // One entry per wallet version, starting at the opening entry (version 1).
    expect(entries.map((entry) => entry.walletVersion)).toEqual([1, 2, 3, 4, 5]);
  });
});

describe('Wallet.rehydrate', () => {
  it('restores persisted state as is', () => {
    const wallet = Wallet.rehydrate({
      id: 'wallet-9',
      playerId: 'player-9',
      currency: 'BRL',
      balance: brl('42.00'),
      version: 7,
      createdAt: AT,
      updatedAt: LATER,
    });

    expect(wallet.balance.equals(brl('42.00'))).toBe(true);
    expect(wallet.version).toBe(7);
    expect(wallet.updatedAt).toEqual(LATER);
  });

  it('does not leak its internal dates', () => {
    const wallet = openWallet();
    wallet.updatedAt.setFullYear(2000);

    expect(wallet.updatedAt).toEqual(AT);
  });
});
