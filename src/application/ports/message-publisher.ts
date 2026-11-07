import { type OutboxMessage } from '../../domain/messaging/outbox-message';

/** A message the broker did not confirm, with the reason it gave (or why none came). */
export interface PublishFailure {
  messageId: string;
  error: string;
}

export interface BatchPublishResult {
  /** Every message NOT confirmed by the broker. Anything not listed here was accepted. */
  failed: PublishFailure[];
}

/**
 * Delivers integration events to the broker. At-least-once: callers retry what failed.
 *
 * Messages go in batches of at most `maxBatchSize`, in the given order. A batch can fail as a
 * whole (the call throws: nothing confirmed) or partially (`failed` lists the rejected ones).
 */
export interface MessagePublisher {
  readonly maxBatchSize: number;
  publishBatch(messages: readonly OutboxMessage[]): Promise<BatchPublishResult>;
}

export const MESSAGE_PUBLISHER = Symbol('MESSAGE_PUBLISHER');
