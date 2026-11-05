import { type MoneyProps } from '../../money/money';
import { type LedgerDirection } from '../../wallet/ledger-direction';
import { type Wallet } from '../../wallet/wallet';
import { type WalletLedgerEntry } from '../../wallet/wallet-ledger-entry';
import { type EventContext, IntegrationEvent } from '../integration-event';

export interface WalletBalanceChangedData {
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  money: MoneyProps;
  balanceBefore: MoneyProps;
  balanceAfter: MoneyProps;
  walletVersion: number;
}

/** Raised only when the balance actually changes, i.e. exactly when a ledger entry exists. */
export class WalletBalanceChanged extends IntegrationEvent<WalletBalanceChangedData> {
  readonly eventType = 'WalletBalanceChanged';
  readonly version = 1;

  static from(wallet: Wallet, entry: WalletLedgerEntry, ctx: EventContext): WalletBalanceChanged {
    if (entry.walletId !== wallet.id) {
      throw new Error(`Ledger entry ${entry.id} does not belong to wallet ${wallet.id}`);
    }
    return new WalletBalanceChanged({
      ...ctx,
      aggregateId: wallet.id,
      data: {
        walletId: wallet.id,
        transactionId: entry.transactionId,
        direction: entry.direction,
        money: entry.money.toJSON(),
        balanceBefore: entry.balanceBefore.toJSON(),
        balanceAfter: entry.balanceAfter.toJSON(),
        walletVersion: wallet.version,
      },
    });
  }
}
