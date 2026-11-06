import { type MoneyProps } from '../../domain/money/money';
import { type FailureCode } from '../../domain/shared/failure-code';
import { type WagerTransaction } from '../../domain/wagering/wager-transaction';
import { type WagerTransactionKind } from '../../domain/wagering/wager-transaction-kind';
import { type WagerTransactionStatus } from '../../domain/wagering/wager-transaction-status';

/** Outcome of a submission (README §9), identical on replays except for `idempotentReplay`. */
export interface WagerSubmissionResult {
  transactionId: string;
  status: WagerTransactionStatus;
  /** Wallet balance observed when the transaction was decided (rule 7.7). */
  balance: MoneyProps | null;
  idempotentReplay: boolean;
  failureCode: FailureCode | null;
}

/** Full read model of a transaction for the query endpoints. */
export interface WagerTransactionView {
  transactionId: string;
  providerId: string;
  externalTransactionId: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: MoneyProps;
  status: WagerTransactionStatus;
  failureCode: FailureCode | null;
  referenceExternalTransactionId: string | null;
  referenceTransactionId: string | null;
  balance: MoneyProps | null;
  attempts: number;
  nextAttemptAt: string | null;
  createdAt: string;
  processedAt: string | null;
}

export function toSubmissionResult(
  transaction: WagerTransaction,
  idempotentReplay: boolean,
): WagerSubmissionResult {
  return {
    transactionId: transaction.id,
    status: transaction.status,
    balance: transaction.observedBalance?.toJSON() ?? null,
    idempotentReplay,
    failureCode: transaction.failureCode ?? null,
  };
}

export function toTransactionView(transaction: WagerTransaction): WagerTransactionView {
  return {
    transactionId: transaction.id,
    providerId: transaction.providerId,
    externalTransactionId: transaction.externalTransactionId,
    walletId: transaction.walletId,
    playerId: transaction.playerId,
    roundId: transaction.roundId,
    gameId: transaction.gameId,
    kind: transaction.kind,
    money: transaction.money.toJSON(),
    status: transaction.status,
    failureCode: transaction.failureCode ?? null,
    referenceExternalTransactionId: transaction.referenceExternalTransactionId ?? null,
    referenceTransactionId: transaction.referenceTransactionId ?? null,
    balance: transaction.observedBalance?.toJSON() ?? null,
    attempts: transaction.attempts,
    nextAttemptAt: transaction.nextAttemptAt?.toISOString() ?? null,
    createdAt: transaction.createdAt.toISOString(),
    processedAt: transaction.processedAt?.toISOString() ?? null,
  };
}
