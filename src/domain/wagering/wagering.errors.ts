import { DomainError } from '../shared/domain-error';
import { type WagerTransactionStatus } from './wager-transaction-status';

export type InvalidWagerTransactionReason =
  /** OPENING (or an unknown kind) submitted from outside. */
  | 'UNSUPPORTED_KIND'
  /** REFUND/ROLLBACK without referenceExternalTransactionId (rule 7.1). */
  | 'REFERENCE_REQUIRED'
  /** BET, or OPENING, carrying a reference. */
  | 'REFERENCE_NOT_ALLOWED'
  /** Transaction referencing itself. */
  | 'SELF_REFERENCE'
  /** Amount must be greater than zero. */
  | 'NON_POSITIVE_AMOUNT'
  /** Missing identifier or malformed payload hash. */
  | 'INVALID_FIELD';

/** Contract violation detected while creating a transaction. Nothing is persisted. */
export class InvalidWagerTransactionError extends DomainError {
  constructor(
    readonly code: InvalidWagerTransactionReason,
    message: string,
  ) {
    super(message);
  }
}

/**
 * Attempt to transition a transaction out of a terminal state, or along an undefined edge.
 * This is a programming error, never a business path.
 */
export class InvalidTransactionStateError extends DomainError {
  readonly code = 'INVALID_TRANSACTION_STATE';

  constructor(
    readonly transactionId: string,
    readonly from: WagerTransactionStatus,
    readonly to: WagerTransactionStatus,
  ) {
    super(`Transaction ${transactionId} cannot transition from ${from} to ${to}`);
  }
}
