import { type MoneyProps } from '../../money/money';
import { type WagerTransaction } from '../../wagering/wager-transaction';
import { WagerTransactionStatus } from '../../wagering/wager-transaction-status';
import { type EventContext, IntegrationEvent } from '../integration-event';
import {
  assertStatus,
  requireObservedBalance,
  snapshotOf,
  type WagerTransactionSnapshot,
} from './wager-transaction-snapshot';

export interface WagerTransactionProcessedData extends WagerTransactionSnapshot {
  referenceTransactionId?: string;
  /** Wallet balance right after the transaction was applied. */
  balance: MoneyProps;
  /** Whether a ledger entry was written (false for LOSS). */
  balanceChanged: boolean;
  processedAt: string;
}

/** Any applied transaction, including LOSS. */
export class WagerTransactionProcessed extends IntegrationEvent<WagerTransactionProcessedData> {
  readonly eventType = 'WagerTransactionProcessed';
  readonly version = 1;

  static from(transaction: WagerTransaction, ctx: EventContext): WagerTransactionProcessed {
    assertStatus(transaction, WagerTransactionStatus.Processed, 'WagerTransactionProcessed');
    const processedAt = transaction.processedAt ?? ctx.occurredAt;
    return new WagerTransactionProcessed({
      ...ctx,
      aggregateId: transaction.id,
      data: {
        ...snapshotOf(transaction),
        ...(transaction.referenceTransactionId !== undefined
          ? { referenceTransactionId: transaction.referenceTransactionId }
          : {}),
        balance: requireObservedBalance(transaction),
        balanceChanged: transaction.affectsBalance(),
        processedAt: processedAt.toISOString(),
      },
    });
  }
}
