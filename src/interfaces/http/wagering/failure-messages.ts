import { FailureCode } from '../../../domain/shared/failure-code';

/** Human-readable explanation of each stable failure code (the code is what clients act on). */
export const FAILURE_MESSAGES: Readonly<Record<FailureCode, string>> = {
  [FailureCode.PlayerWalletMismatch]: 'The player does not own this wallet',
  [FailureCode.CurrencyMismatch]: 'The operation currency differs from the wallet currency',
  [FailureCode.InsufficientFunds]: 'Insufficient funds for this bet',
  [FailureCode.ReversalInsufficientFunds]:
    'Reversing this transaction would make the balance negative',
  [FailureCode.BalanceLimitExceeded]:
    'This credit would push the balance past the largest amount a wallet can hold',
  [FailureCode.ReferenceNotFound]: 'The referenced transaction never arrived',
  [FailureCode.ReferenceKindNotAllowed]: 'This operation cannot reference that kind of transaction',
  [FailureCode.ReferenceContextMismatch]:
    'The reference belongs to another provider, player, wallet, currency or round',
  [FailureCode.ReferenceNotProcessed]: 'The referenced transaction was not applied',
  [FailureCode.ReferenceAlreadyReversed]: 'The referenced transaction was already reversed',
  [FailureCode.ReferenceAmountMismatch]:
    'The amount must equal the referenced transaction amount (no partial reversal)',
  [FailureCode.ProcessingFailed]: 'Processing failed permanently',
};
