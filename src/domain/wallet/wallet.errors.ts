import { type Money } from '../money/money';
import { DomainError } from '../shared/domain-error';

export class InvalidWalletError extends DomainError {
  readonly code = 'INVALID_WALLET';
}

export class InsufficientFundsError extends DomainError {
  readonly code = 'INSUFFICIENT_FUNDS';

  constructor(
    readonly walletId: string,
    readonly balance: Money,
    readonly requested: Money,
  ) {
    super(`Wallet ${walletId} has insufficient funds for a debit of ${requested.toString()}`);
  }
}

export class InvalidLedgerEntryError extends DomainError {
  readonly code = 'INVALID_LEDGER_ENTRY';
}
