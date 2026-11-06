import { describe, expect, it } from 'bun:test';
import { LedgerDirection } from '../../../../src/domain/wallet/ledger-direction';
import {
  type CreateLedgerEntryProps,
  WalletLedgerEntry,
} from '../../../../src/domain/wallet/wallet-ledger-entry';
import { InvalidLedgerEntryError } from '../../../../src/domain/wallet/wallet.errors';
import { AT, brl, usd } from '../fixtures';

const props = (overrides: Partial<CreateLedgerEntryProps> = {}): CreateLedgerEntryProps => ({
  id: 'entry-1',
  walletId: 'wallet-1',
  transactionId: 'tx-1',
  direction: LedgerDirection.Debit,
  money: brl('25.00'),
  balanceBefore: brl('100.00'),
  balanceAfter: brl('75.00'),
  walletVersion: 2,
  createdAt: AT,
  ...overrides,
});

describe('WalletLedgerEntry.create', () => {
  it('accepts a balanced debit', () => {
    expect(WalletLedgerEntry.create(props()).isBalanced()).toBe(true);
  });

  it('accepts a balanced credit', () => {
    const entry = WalletLedgerEntry.create(
      props({ direction: LedgerDirection.Credit, balanceAfter: brl('125.00') }),
    );

    expect(entry.isBalanced()).toBe(true);
  });

  it('rejects unbalanced arithmetic', () => {
    expect(() => WalletLedgerEntry.create(props({ balanceAfter: brl('80.00') }))).toThrow(
      InvalidLedgerEntryError,
    );
  });

  it('rejects the wrong direction for the arithmetic', () => {
    expect(() => WalletLedgerEntry.create(props({ direction: LedgerDirection.Credit }))).toThrow(
      InvalidLedgerEntryError,
    );
  });

  it('rejects mixed currencies', () => {
    expect(() => WalletLedgerEntry.create(props({ money: usd('25.00') }))).toThrow(
      InvalidLedgerEntryError,
    );
  });

  it.each([
    ['zero', brl('0.00')],
    ['negative', brl('25.00').negate()],
  ])('rejects a %s amount', (_, money) => {
    expect(() => WalletLedgerEntry.create(props({ money }))).toThrow(InvalidLedgerEntryError);
  });

  it.each([0, -1, 1.5])('rejects wallet version %p', (walletVersion) => {
    expect(() => WalletLedgerEntry.create(props({ walletVersion }))).toThrow(
      InvalidLedgerEntryError,
    );
  });

  it('rejects a negative resulting balance', () => {
    expect(() =>
      WalletLedgerEntry.create(
        props({ balanceBefore: brl('10.00'), balanceAfter: brl('15.00').negate() }),
      ),
    ).toThrow(InvalidLedgerEntryError);
  });
});

describe('WalletLedgerEntry immutability', () => {
  it('is frozen: no field can be reassigned', () => {
    const entry = WalletLedgerEntry.create(props());

    expect(Object.isFrozen(entry)).toBe(true);
    expect(() => {
      (entry as unknown as { balanceAfter: unknown }).balanceAfter = brl('0.00');
    }).toThrow(TypeError);
  });

  it('exposes no transition methods', () => {
    const methods = Object.getOwnPropertyNames(WalletLedgerEntry.prototype).filter(
      (name) => name !== 'constructor',
    );

    expect(methods).toEqual(['isBalanced']);
  });
});

describe('WalletLedgerEntry.rehydrate', () => {
  it('rebuilds persisted state without revalidating it', () => {
    // Corrupted data is not hidden on read: reconciliation must be able to detect it.
    const entry = WalletLedgerEntry.rehydrate(props({ balanceAfter: brl('1.00') }));

    expect(entry.isBalanced()).toBe(false);
  });
});
