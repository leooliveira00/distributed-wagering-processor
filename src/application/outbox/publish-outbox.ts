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
 * 2. Publish each message, in occurrence order.
 * 3. Mark the published ones in one statement; schedule a backoff retry for the failures.
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
    for (const message of batch) {
      try {
        await this.publisher.publish(message);
      } catch (error) {
        failed++;
        message.scheduleRetry(this.clock.now(), this.options.retry);
        const delayMs = backoffDelayMs(message.attempts, this.options.retry);
        await this.unitOfWork.run((scope) => scope.outbox.saveRetry(message, delayMs));
        this.metrics.increment('outbox_publish_failures_total', { eventType: message.eventType });
        this.logger.warn('Outbox publication failed, retry scheduled', {
          eventId: message.id,
          eventType: message.eventType,
          attempts: message.attempts,
          nextAttemptAt: message.nextAttemptAt?.toISOString(),
          error: error instanceof Error ? error.message : String(error),
        });
        continue;
      }
      // Outside the try: a crash here is the process dying, not a failed publication.
      this.faults.trigger('outbox:after-publish');
      published.push(message.id);
    }

    await this.unitOfWork.run((scope) => scope.outbox.markPublished(published, this.clock.now()));
    this.metrics.increment('outbox_events_published_total', {}, published.length);
    return { claimed: batch.length, published: published.length, failed };
  }
}
