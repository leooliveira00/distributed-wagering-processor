import { type OutboxMessage } from '../../domain/messaging/outbox-message';
import { backoffDelayMs, type BackoffPolicy } from '../../domain/shared/backoff';
import { type FaultInjector } from '../ports/fault-injector';
import { type AppLogger } from '../ports/logger';
import { type MessagePublisher } from '../ports/message-publisher';
import { type Metrics } from '../ports/metrics';
import { type Clock } from '../ports/system';
import { type UnitOfWork } from '../ports/unit-of-work';

export interface PublishOutboxOptions {
  batchSize: number;
  leaseMs: number;
  retry: BackoffPolicy;
}

export interface PublishOutboxResult {
  claimed: number;
  published: number;
  failed: number;
}

/**
 * One publishing pass (README §11).
 *
 * 1. Lease a batch in a short transaction (committed before any network call).
 * 2. Publish it in occurrence order, in chunks of the publisher's batch size (one broker round
 *    trip per chunk, not per message).
 * 3. Mark the confirmed ones in one statement; schedule a backoff retry for the rest. A message
 *    is marked only when the broker confirmed it.
 *
 * Crash windows are all safe: dying after the claim leaves messages leased until the lease
 * expires, then another instance takes them; dying after publishing but before marking leads to a
 * second publication with the same deduplication id. Events are never dropped: retries go on
 * forever with a capped backoff, and persistent failures show up in metrics.
 */
export class PublishOutbox {
  constructor(
    private readonly unitOfWork: UnitOfWork,
    private readonly publisher: MessagePublisher,
    private readonly clock: Clock,
    private readonly metrics: Metrics,
    private readonly logger: AppLogger,
    private readonly faults: FaultInjector,
    private readonly options: PublishOutboxOptions,
  ) {}

  async runOnce(): Promise<PublishOutboxResult> {
    const batch = await this.unitOfWork.run((scope) =>
      scope.outbox.claimDue({ limit: this.options.batchSize, leaseMs: this.options.leaseMs }),
    );
    if (batch.length === 0) return { claimed: 0, published: 0, failed: 0 };
    this.faults.trigger('outbox:after-claim');

    const published: string[] = [];
    let failed = 0;
    const size = Math.max(1, this.publisher.maxBatchSize);
    for (let start = 0; start < batch.length; start += size) {
      const chunk = batch.slice(start, start + size);
      const failures = await this.publishChunk(chunk);
      // Outside any try: a crash here is the process dying after the broker accepted something
      // and before it was marked, not a failed publication.
      if (failures.size < chunk.length) this.faults.trigger('outbox:after-publish');

      for (const message of chunk) {
        const failure = failures.get(message.id);
        if (failure !== undefined) {
          failed++;
          await this.scheduleRetry(message, failure);
          continue;
        }
        published.push(message.id);
        // Commit-to-broker delay. occurredAt comes from the instance that committed the event,
        // so clock skew between instances shifts it slightly: a trend indicator, not exact.
        this.metrics.observe(
          'outbox_publish_delay_seconds',
          Math.max(0, this.clock.now().getTime() - message.occurredAt.getTime()) / 1000,
        );
      }
    }

    await this.unitOfWork.run((scope) => scope.outbox.markPublished(published, this.clock.now()));
    this.metrics.increment('outbox_events_published_total', {}, published.length);
    return { claimed: batch.length, published: published.length, failed };
  }

  /** Reason per message the broker did not confirm; a failed call fails the whole chunk. */
  private async publishChunk(chunk: readonly OutboxMessage[]): Promise<Map<string, string>> {
    try {
      const { failed } = await this.publisher.publishBatch(chunk);
      return new Map(failed.map((failure) => [failure.messageId, failure.error]));
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      return new Map(chunk.map((message) => [message.id, reason]));
    }
  }

  private async scheduleRetry(message: OutboxMessage, error: string): Promise<void> {
    message.scheduleRetry(this.clock.now(), this.options.retry);
    const delayMs = backoffDelayMs(message.attempts, this.options.retry);
    await this.unitOfWork.run((scope) => scope.outbox.saveRetry(message, delayMs));
    this.metrics.increment('outbox_publish_failures_total', { eventType: message.eventType });
    this.logger.warn('Outbox publication failed, retry scheduled', {
      eventId: message.id,
      eventType: message.eventType,
      attempts: message.attempts,
      nextAttemptAt: message.nextAttemptAt?.toISOString(),
      error,
    });
  }
}
