import { type MoneyProps } from '../../domain/money/money';
import { type BackoffPolicy } from '../../domain/shared/backoff';
import { type WagerTransactionKind } from '../../domain/wagering/wager-transaction-kind';

/** A provider operation, identical whether it arrives over HTTP or SQS. */
export interface SubmitWagerCommand {
  providerId: string;
  externalTransactionId: string;
  /** HTTP `Idempotency-Key` header or `data.idempotencyKey` of the queue message. */
  idempotencyKey: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: MoneyProps;
  referenceExternalTransactionId?: string | undefined;
}

/** Message-level deduplication for queue entries (README §10). */
export interface InboxContext {
  consumerName: string;
  messageId: string;
}

/** Retry schedule for transactions waiting for their reference (README §7.1, D11). */
export interface PendingReferencePolicy {
  backoff: BackoffPolicy;
  maxAttempts: number;
}

export const PENDING_REFERENCE_POLICY = Symbol('PENDING_REFERENCE_POLICY');

/**
 * Business fields covered by the payload hash (README §9). The idempotency key and transport
 * metadata (headers, messageId, occurredAt) are deliberately excluded, so the same operation
 * hashes the same over HTTP and SQS. The hash is SHA-256 of the canonical JSON of this object.
 */
export function wagerBusinessPayload(command: SubmitWagerCommand): Record<string, unknown> {
  return {
    providerId: command.providerId,
    externalTransactionId: command.externalTransactionId,
    playerId: command.playerId,
    walletId: command.walletId,
    roundId: command.roundId,
    gameId: command.gameId,
    kind: command.kind,
    money: { amount: command.money.amount, currency: command.money.currency },
    referenceExternalTransactionId: command.referenceExternalTransactionId,
  };
}
