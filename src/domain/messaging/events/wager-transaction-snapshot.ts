import { type MoneyProps } from '../../money/money';
import { type WagerTransaction } from '../../wagering/wager-transaction';
import { type WagerTransactionKind } from '../../wagering/wager-transaction-kind';
import { type WagerTransactionStatus } from '../../wagering/wager-transaction-status';

/** Fields shared by every wager transaction event, as plain JSON. */
export interface WagerTransactionSnapshot {
  transactionId: string;
  providerId: string;
  externalTransactionId: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  status: WagerTransactionStatus;
  money: MoneyProps;
  referenceExternalTransactionId?: string;
}

export function snapshotOf(transaction: WagerTransaction): WagerTransactionSnapshot {
  return {
    transactionId: transaction.id,
    providerId: transaction.providerId,
    externalTransactionId: transaction.externalTransactionId,
    walletId: transaction.walletId,
    playerId: transaction.playerId,
    roundId: transaction.roundId,
    gameId: transaction.gameId,
    kind: transaction.kind,
    status: transaction.status,
    money: transaction.money.toJSON(),
    ...(transaction.referenceExternalTransactionId !== undefined
      ? { referenceExternalTransactionId: transaction.referenceExternalTransactionId }
      : {}),
  };
}

export function assertStatus(
  transaction: WagerTransaction,
  expected: WagerTransactionStatus,
  eventType: string,
): void {
  if (transaction.status !== expected) {
    throw new Error(
      `${eventType} requires a ${expected} transaction, ${transaction.id} is ${transaction.status}`,
    );
  }
}

export function requireObservedBalance(transaction: WagerTransaction): MoneyProps {
  const balance = transaction.observedBalance;
  if (!balance) throw new Error(`Transaction ${transaction.id} has no observed balance`);
  return balance.toJSON();
}
