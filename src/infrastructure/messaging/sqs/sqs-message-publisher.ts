import {
  GetQueueUrlCommand,
  SendMessageBatchCommand,
  type SendMessageBatchRequestEntry,
  type SQSClient,
} from '@aws-sdk/client-sqs';
import {
  type BatchPublishResult,
  type MessagePublisher,
} from '../../../application/ports/message-publisher';
import { type OutboxMessage } from '../../../domain/messaging/outbox-message';

/** SQS limit for SendMessageBatch. */
const SQS_MAX_BATCH = 10;

/**
 * Publishes integration events to a FIFO queue, up to 10 per SendMessageBatch call: one round
 * trip per chunk instead of one per event, so fewer requests to the broker (and lower cost on SQS,
 * which bills per request).
 * - MessageGroupId = walletId: events of one wallet keep their order in the broker, aligned with
 *   the unit of concurrency (falls back to the aggregate id for events without a wallet).
 *   Entries of one batch keep their order within a group.
 * - MessageDeduplicationId = eventId: a republished event (publisher crash after sending, lease
 *   expiry) is dropped by the broker, and consumers can deduplicate by the same key afterwards.
 * Only entries the broker lists as successful count as published; anything else is retried.
 * Broker ordering and deduplication are optimizations; consumers must stay idempotent.
 */
export class SqsMessagePublisher implements MessagePublisher {
  readonly maxBatchSize = SQS_MAX_BATCH;
  private queueUrl: Promise<string> | undefined;

  constructor(
    private readonly sqs: SQSClient,
    private readonly queueName: string,
  ) {}

  async publishBatch(messages: readonly OutboxMessage[]): Promise<BatchPublishResult> {
    if (messages.length === 0) return { failed: [] };
    if (messages.length > this.maxBatchSize) {
      throw new Error(
        `A batch holds at most ${String(this.maxBatchSize)} messages, got ${String(messages.length)}`,
      );
    }
    const { Successful = [], Failed = [] } = await this.sqs.send(
      new SendMessageBatchCommand({
        QueueUrl: await this.resolveQueueUrl(),
        // The entry id is the position in the batch: unique and within SQS's id format.
        Entries: messages.map((message, index) => entryOf(message, String(index))),
      }),
    );
    const confirmed = new Set(Successful.map((entry) => entry.Id));
    const reasons = new Map(Failed.map((entry) => [entry.Id, entry.Code ?? entry.Message]));
    return {
      failed: messages
        .map((message, index) => ({ message, entryId: String(index) }))
        .filter(({ entryId }) => !confirmed.has(entryId))
        .map(({ message, entryId }) => ({
          messageId: message.id,
          error: reasons.get(entryId) ?? 'not confirmed by the broker',
        })),
    };
  }

  private resolveQueueUrl(): Promise<string> {
    this.queueUrl ??= this.sqs
      .send(new GetQueueUrlCommand({ QueueName: this.queueName }))
      .then(({ QueueUrl }) => {
        if (!QueueUrl) throw new Error(`Queue ${this.queueName} has no URL`);
        return QueueUrl;
      })
      .catch((error: unknown) => {
        this.queueUrl = undefined; // retry the lookup on the next publish
        throw error;
      });
    return this.queueUrl;
  }
}

function entryOf(message: OutboxMessage, id: string): SendMessageBatchRequestEntry {
  return {
    Id: id,
    MessageBody: JSON.stringify(message.payload),
    MessageGroupId: groupIdOf(message),
    MessageDeduplicationId: message.id,
    MessageAttributes: {
      eventType: { DataType: 'String', StringValue: message.eventType },
    },
  };
}

function groupIdOf(message: OutboxMessage): string {
  const data = message.payload.data;
  if (
    typeof data === 'object' &&
    data !== null &&
    'walletId' in data &&
    typeof data.walletId === 'string'
  ) {
    return data.walletId;
  }
  return message.aggregateId;
}
