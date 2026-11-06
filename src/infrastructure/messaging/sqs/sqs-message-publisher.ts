import { GetQueueUrlCommand, SendMessageCommand, type SQSClient } from '@aws-sdk/client-sqs';
import { type MessagePublisher } from '../../../application/ports/message-publisher';
import { type OutboxMessage } from '../../../domain/messaging/outbox-message';

/**
 * Publishes integration events to a FIFO queue.
 * - MessageGroupId = walletId: events of one wallet keep their order in the broker, aligned with
 *   the unit of concurrency (falls back to the aggregate id for events without a wallet).
 * - MessageDeduplicationId = eventId: a republished event (publisher crash after sending, lease
 *   expiry) is dropped by the broker, and consumers can deduplicate by the same key afterwards.
 * Broker ordering and deduplication are optimizations; consumers must stay idempotent.
 */
export class SqsMessagePublisher implements MessagePublisher {
  private queueUrl: Promise<string> | undefined;

  constructor(
    private readonly sqs: SQSClient,
    private readonly queueName: string,
  ) {}

  async publish(message: OutboxMessage): Promise<void> {
    await this.sqs.send(
      new SendMessageCommand({
        QueueUrl: await this.resolveQueueUrl(),
        MessageBody: JSON.stringify(message.payload),
        MessageGroupId: groupIdOf(message),
        MessageDeduplicationId: message.id,
        MessageAttributes: {
          eventType: { DataType: 'String', StringValue: message.eventType },
        },
      }),
    );
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
