import { type FailureCode } from '../../shared/failure-code';
import { type WagerTransaction } from '../../wagering/wager-transaction';
import { WagerTransactionStatus } from '../../wagering/wager-transaction-status';
import { type EventContext, IntegrationEvent } from '../integration-event';
import {
  assertStatus,
  snapshotOf,
  type WagerTransactionSnapshot,
} from './wager-transaction-snapshot';

export interface WagerTransactionFailedData extends WagerTransactionSnapshot {
  failureCode: FailureCode;
}

/**
 * Permanent processing failure (README §6.3: FAILED, terminal and auditable): the transaction
 * will never be applied and needs investigation. Not a business rejection, so it is not
 * WagerTransactionRejected. Beyond the minimum events of README §11; the balance is untouched.
 */
export class WagerTransactionFailed extends IntegrationEvent<WagerTransactionFailedData> {
  readonly eventType = 'WagerTransactionFailed';
  readonly version = 1;

  static from(transaction: WagerTransaction, ctx: EventContext): WagerTransactionFailed {
    assertStatus(transaction, WagerTransactionStatus.Failed, 'WagerTransactionFailed');
    const failureCode = transaction.failureCode;
    if (failureCode === undefined) {
      throw new Error(`Failed transaction ${transaction.id} has no failure code`);
    }
    return new WagerTransactionFailed({
      ...ctx,
      aggregateId: transaction.id,
      data: { ...snapshotOf(transaction), failureCode },
    });
  }
}
