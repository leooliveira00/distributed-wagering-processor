import { type WagerTransaction } from '../../wagering/wager-transaction';
import { WagerTransactionStatus } from '../../wagering/wager-transaction-status';
import { type EventContext, IntegrationEvent } from '../integration-event';
import {
  assertStatus,
  snapshotOf,
  type WagerTransactionSnapshot,
} from './wager-transaction-snapshot';

export interface WagerTransactionPendingReferenceData extends WagerTransactionSnapshot {
  referenceExternalTransactionId: string;
  attempts: number;
  nextAttemptAt: string;
}

/** The referenced transaction has not been applied yet; a worker will retry. */
export class WagerTransactionPendingReference extends IntegrationEvent<WagerTransactionPendingReferenceData> {
  readonly eventType = 'WagerTransactionPendingReference';
  readonly version = 1;

  static from(transaction: WagerTransaction, ctx: EventContext): WagerTransactionPendingReference {
    assertStatus(
      transaction,
      WagerTransactionStatus.PendingReference,
      'WagerTransactionPendingReference',
    );
    const reference = transaction.referenceExternalTransactionId;
    const nextAttemptAt = transaction.nextAttemptAt;
    if (reference === undefined || nextAttemptAt === undefined) {
      throw new Error(`Pending transaction ${transaction.id} lacks reference or retry time`);
    }
    return new WagerTransactionPendingReference({
      ...ctx,
      aggregateId: transaction.id,
      data: {
        ...snapshotOf(transaction),
        referenceExternalTransactionId: reference,
        attempts: transaction.attempts,
        nextAttemptAt: nextAttemptAt.toISOString(),
      },
    });
  }
}
