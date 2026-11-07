import { type BackoffPolicy, nextAttemptAt } from '../shared/backoff';
import { deepFreeze } from '../shared/deep-freeze';
import { type IntegrationEvent } from './integration-event';
import { InvalidMessageStateError } from './messaging.errors';

export interface OutboxMessageState {
  id: string;
  aggregateId: string;
  eventType: string;
  payload: Readonly<Record<string, unknown>>;
  occurredAt: Date;
  attempts: number;
  nextAttemptAt: Date | undefined;
  publishedAt: Date | undefined;
}

/** Publish retries: 1s, 2s, 4s ... capped at 60s. */
export const OUTBOX_RETRY_POLICY: BackoffPolicy = { baseMs: 1_000, capMs: 60_000 };

/**
 * Integration event waiting to be published. Written in the same SQL transaction as the
 * financial change, so no confirmed event is lost, and never published before that commit.
 *
 * The outbox id is the event id: the broker deduplication id and the consumer-side
 * deduplication key are the same value, so a repeated publication stays safe.
 */
export class OutboxMessage {
  private constructor(
    public readonly id: string,
    public readonly aggregateId: string,
    public readonly eventType: string,
    public readonly payload: Readonly<Record<string, unknown>>,
    public readonly occurredAt: Date,
    private _attempts: number,
    private _nextAttemptAt: Date | undefined,
    private _publishedAt: Date | undefined,
  ) {}

  static enqueue(event: IntegrationEvent<unknown>): OutboxMessage {
    const payload: Record<string, unknown> = { ...event.toJSON() };
    return new OutboxMessage(
      event.eventId,
      event.aggregateId,
      event.eventType,
      deepFreeze(payload),
      new Date(event.occurredAt),
      0,
      undefined,
      undefined,
    );
  }

  /** Reconstruction from persistence. Does not revalidate. */
  static rehydrate(state: OutboxMessageState): OutboxMessage {
    return new OutboxMessage(
      state.id,
      state.aggregateId,
      state.eventType,
      deepFreeze(structuredClone(state.payload)),
      new Date(state.occurredAt),
      state.attempts,
      state.nextAttemptAt ? new Date(state.nextAttemptAt) : undefined,
      state.publishedAt ? new Date(state.publishedAt) : undefined,
    );
  }

  get attempts(): number {
    return this._attempts;
  }

  get nextAttemptAt(): Date | undefined {
    return this._nextAttemptAt ? new Date(this._nextAttemptAt) : undefined;
  }

  get publishedAt(): Date | undefined {
    return this._publishedAt ? new Date(this._publishedAt) : undefined;
  }

  isPending(): boolean {
    return this._publishedAt === undefined;
  }

  isDue(now: Date): boolean {
    return (
      this.isPending() &&
      (this._nextAttemptAt === undefined || this._nextAttemptAt.getTime() <= now.getTime())
    );
  }

  markPublished(at: Date): void {
    this.assertPending('markPublished');
    this._publishedAt = new Date(at);
    this._nextAttemptAt = undefined;
  }

  /** Increments attempts and computes the next attempt time with exponential backoff. */
  scheduleRetry(now: Date, policy: BackoffPolicy = OUTBOX_RETRY_POLICY): void {
    this.assertPending('scheduleRetry');
    this._attempts++;
    this._nextAttemptAt = nextAttemptAt(now, this._attempts, policy);
  }

  private assertPending(operation: string): void {
    if (!this.isPending()) {
      throw new InvalidMessageStateError(
        `Outbox message ${this.id} is already published; ${operation} is not allowed`,
      );
    }
  }
}
