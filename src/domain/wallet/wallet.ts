import { CurrencyMismatchError } from '../money/money.errors';
import { Money } from '../money/money';
import { LedgerDirection } from './ledger-direction';
import { WalletLedgerEntry } from './wallet-ledger-entry';
import { InsufficientFundsError, InvalidWalletError } from './wallet.errors';

export interface WalletState {
  id: string;
  playerId: string;
  currency: string;
  balance: Money;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface OpenWalletProps {
  id: string;
  playerId: string;
  initialBalance: Money;
  /** Internal OPENING transaction that the opening ledger entry points to. */
  openingTransactionId: string;
  openingEntryId: string;
  at: Date;
}

export interface OpenedWallet {
  wallet: Wallet;
  /** Present only when the initial balance is greater than zero. */
  openingEntry: WalletLedgerEntry | undefined;
}

/** Identity and timestamp of the ledger entry a balance change produces. */
export interface MovementProps {
  transactionId: string;
  entryId: string;
  at: Date;
}

/**
 * Aggregate root and unit of concurrency. Every balance change goes through `debit`/`credit`,
 * which produce the matching ledger entry, so balance and ledger can never diverge in memory.
 *
 * `version` starts at 1 and increments only when the balance changes. Persistence uses it as a
 * second line of defence (`UPDATE ... WHERE version = ?`) behind the pessimistic row lock.
 */
export class Wallet {
  private constructor(
    public readonly id: string,
    public readonly playerId: string,
    public readonly currency: string,
    private _balance: Money,
    private _version: number,
    public readonly createdAt: Date,
    private _updatedAt: Date,
  ) {}

  static open(props: OpenWalletProps): OpenedWallet {
    const { initialBalance, at } = props;
    if (props.id.length === 0 || props.playerId.length === 0) {
      throw new InvalidWalletError('Wallet id and player id are required');
    }
    if (initialBalance.isNegative()) {
      throw new InvalidWalletError('Initial balance cannot be negative');
    }

    const wallet = new Wallet(
      props.id,
      props.playerId,
      initialBalance.currency,
      initialBalance,
      1,
      new Date(at),
      new Date(at),
    );
    const openingEntry = initialBalance.isPositive()
      ? WalletLedgerEntry.create({
          id: props.openingEntryId,
          walletId: props.id,
          transactionId: props.openingTransactionId,
          direction: LedgerDirection.Credit,
          money: initialBalance,
          balanceBefore: Money.zero(initialBalance.currency),
          balanceAfter: initialBalance,
          walletVersion: 1,
          createdAt: new Date(at),
        })
      : undefined;

    return { wallet, openingEntry };
  }

  /** Reconstruction from persistence. Does not revalidate. */
  static rehydrate(state: WalletState): Wallet {
    return new Wallet(
      state.id,
      state.playerId,
      state.currency,
      state.balance,
      state.version,
      new Date(state.createdAt),
      new Date(state.updatedAt),
    );
  }

  get balance(): Money {
    return this._balance;
  }

  get version(): number {
    return this._version;
  }

  get updatedAt(): Date {
    return new Date(this._updatedAt);
  }

  canDebit(money: Money): boolean {
    this.assertSameCurrency(money);
    return !this._balance.isLessThan(money);
  }

  debit(money: Money, movement: MovementProps): WalletLedgerEntry {
    if (!this.canDebit(money)) {
      throw new InsufficientFundsError(this.id, this._balance, money);
    }
    return this.apply(LedgerDirection.Debit, money, movement);
  }

  credit(money: Money, movement: MovementProps): WalletLedgerEntry {
    this.assertSameCurrency(money);
    return this.apply(LedgerDirection.Credit, money, movement);
  }

  private apply(
    direction: LedgerDirection,
    money: Money,
    movement: MovementProps,
  ): WalletLedgerEntry {
    const balanceAfter =
      direction === LedgerDirection.Credit
        ? this._balance.add(money)
        : this._balance.subtract(money);

    // The entry validates the arithmetic before any state changes, keeping the change atomic.
    const entry = WalletLedgerEntry.create({
      id: movement.entryId,
      walletId: this.id,
      transactionId: movement.transactionId,
      direction,
      money,
      balanceBefore: this._balance,
      balanceAfter,
      walletVersion: this._version + 1,
      createdAt: new Date(movement.at),
    });

    this._balance = balanceAfter;
    this._version = entry.walletVersion;
    this._updatedAt = new Date(movement.at);
    return entry;
  }

  private assertSameCurrency(money: Money): void {
    if (money.currency !== this.currency) {
      throw new CurrencyMismatchError(this.currency, money.currency);
    }
  }
}
