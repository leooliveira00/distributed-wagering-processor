import {
  ConflictError,
  IntegrityViolationError,
  InvalidRequestError,
  NotFoundError,
  TransientError,
} from '../../application/errors';
import { type WagerSubmissionResult } from '../../application/wagering/wager-views';
import { InvalidMessageError } from '../../domain/messaging/messaging.errors';
import { InvalidMoneyError } from '../../domain/money/money.errors';
import { type DomainError } from '../../domain/shared/domain-error';
import { WagerTransactionStatus } from '../../domain/wagering/wager-transaction-status';
import { InvalidWagerTransactionError } from '../../domain/wagering/wagering.errors';
import { InvalidWalletError } from '../../domain/wallet/wallet.errors';

/** Bounded set of reasons, safe to use as metric labels. */
export type DeadLetterReason =
  'malformed_message' | 'invalid_payload' | 'wallet_not_found' | 'integrity_violation';

export type AckOutcome =
  'processed' | 'pending_reference' | 'rejected' | 'failed' | 'duplicate' | 'conflict';

/**
 * What the consumer does with a message (README §10):
 * - ack: terminal outcome, delete the message (only ever after the commit);
 * - retry: transient failure, keep the message and back off via its visibility timeout;
 *   the queue's redrive policy moves it to the DLQ after maxReceiveCount receives;
 * - dead-letter: permanent failure, move it to the DLQ now with the reason.
 */
export type Disposition =
  | { action: 'ack'; outcome: AckOutcome }
  | { action: 'retry'; reason: 'transient' | 'unexpected'; code: string }
  | { action: 'dead-letter'; reason: DeadLetterReason; code: string };

const OUTCOME_BY_STATUS: Readonly<Partial<Record<WagerTransactionStatus, AckOutcome>>> = {
  [WagerTransactionStatus.Processed]: 'processed',
  [WagerTransactionStatus.PendingReference]: 'pending_reference',
  [WagerTransactionStatus.Rejected]: 'rejected',
  [WagerTransactionStatus.Failed]: 'failed', // terminal: retrying the message cannot change it
};

/** Domain errors meaning "this input breaks the contract": never fixable by retrying. */
const CONTRACT_ERRORS = [
  InvalidMoneyError,
  InvalidWagerTransactionError,
  InvalidMessageError,
  InvalidWalletError,
];

export function dispositionOfResult(result: WagerSubmissionResult): Disposition {
  if (result.idempotentReplay) return { action: 'ack', outcome: 'duplicate' };
  return { action: 'ack', outcome: OUTCOME_BY_STATUS[result.status] ?? 'processed' };
}

export function dispositionOfError(error: unknown): Disposition {
  // Business conflicts are terminal: the original transaction is intact in the database.
  if (error instanceof ConflictError) return { action: 'ack', outcome: 'conflict' };

  // Nothing was persisted for these: the DLQ keeps the message auditable for investigation.
  if (error instanceof InvalidRequestError) {
    return { action: 'dead-letter', reason: 'invalid_payload', code: error.code };
  }
  if (CONTRACT_ERRORS.some((type) => error instanceof type)) {
    return { action: 'dead-letter', reason: 'invalid_payload', code: (error as DomainError).code };
  }
  if (error instanceof NotFoundError) {
    return { action: 'dead-letter', reason: 'wallet_not_found', code: error.code };
  }
  // A database guarantee rejected the write: a bug, retrying cannot help.
  if (error instanceof IntegrityViolationError) {
    return { action: 'dead-letter', reason: 'integrity_violation', code: error.code };
  }

  if (error instanceof TransientError) {
    return { action: 'retry', reason: 'transient', code: error.code };
  }
  // Unknown failures are never swallowed: retried, and dead-lettered by the redrive policy.
  return { action: 'retry', reason: 'unexpected', code: 'UNEXPECTED_ERROR' };
}
