import { type MoneyProps } from '../../money/money';
import { type FailureCode } from '../../shared/failure-code';
import { type WagerTransaction } from '../../wagering/wager-transaction';
import { WagerTransactionStatus } from '../../wagering/wager-transaction-status';
import { type EventContext, IntegrationEvent } from '../integration-event';
import {
  assertStatus,
  requireObservedBalance,
  snapshotOf,
  type WagerTransactionSnapshot,
} from './wager-transaction-snapshot';

export interface WagerTransactionRejectedData extends WagerTransactionSnapshot {
  failureCode: FailureCode;
  /** Wallet balance observed when the transaction was rejected (unchanged by it). */
  balance: MoneyProps;
}

/** Business rule violation, including references that never arrived (rule 7.1). */
export class WagerTransactionRejected extends IntegrationEvent<WagerTransactionRejectedData> {
  readonly eventType = 'WagerTransactionRejected';
  readonly version = 1;

  static from(transaction: WagerTransaction, ctx: EventContext): WagerTransactionRejected {
    assertStatus(transaction, WagerTransactionStatus.Rejected, 'WagerTransactionRejected');
    const failureCode = transaction.failureCode;
    if (failureCode === undefined) {
      throw new Error(`Rejected transaction ${transaction.id} has no failure code`);
    }
    return new WagerTransactionRejected({
      ...ctx,
      aggregateId: transaction.id,
      data: {
        ...snapshotOf(transaction),
        failureCode,
        balance: requireObservedBalance(transaction),
      },
    });
  }
}
