import { z } from 'zod';
import { WagerTransactionKind } from '../../domain/wagering/wager-transaction-kind';

/**
 * Wire contracts shared by every entry point (HTTP and SQS), so a wager operation is validated by
 * exactly the same rules wherever it comes from (README §10: one use case, one contract).
 */

/** 1 to 255 visible ASCII characters (fits the idempotency_key column). */
export const IDEMPOTENCY_KEY_PATTERN = /^[\x21-\x7E]{1,255}$/;

/** Safe correlation ids only: an external value reaches the logs, so it must not forge lines. */
export const CORRELATION_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

export function isSafeCorrelationId(value: unknown): value is string {
  return typeof value === 'string' && CORRELATION_ID_PATTERN.test(value);
}

/** Business fields of a wager operation (README §9 request body). */
export const wagerOperationSchema = z.strictObject({
  providerId: z.string().min(1).max(64),
  externalTransactionId: z.string().min(1).max(128),
  playerId: z.uuid(),
  walletId: z.uuid(),
  roundId: z.string().min(1).max(128),
  gameId: z.string().min(1).max(128),
  kind: z.enum(WagerTransactionKind),
  // Shape only: the amount format is validated by the Money value object.
  money: z.strictObject({ amount: z.string(), currency: z.string() }),
  referenceExternalTransactionId: z.string().min(1).max(128).optional(),
});

/** Queue envelope (README §10). The idempotency key travels inside `data`. */
export const wagerMessageSchema = z.strictObject({
  messageId: z.string().min(1).max(255),
  type: z.literal('WagerTransactionRequested'),
  occurredAt: z.iso.datetime(),
  data: wagerOperationSchema.extend({
    idempotencyKey: z.string().regex(IDEMPOTENCY_KEY_PATTERN),
  }),
});

export type WagerMessage = z.output<typeof wagerMessageSchema>;
