import {
  CreateQueueCommand,
  DeleteMessageCommand,
  DeleteQueueCommand,
  ReceiveMessageCommand,
  type SQSClient,
} from '@aws-sdk/client-sqs';
import { type Env } from '../../../src/infrastructure/config/env';
import { createSqsClient } from '../../../src/infrastructure/messaging/sqs/sqs-client';

export interface ReceivedMessage {
  body: Record<string, unknown>;
  groupId: string | undefined;
  deduplicationId: string | undefined;
  eventType: string | undefined;
}

export interface TestQueue {
  name: string;
  url: string;
  sqs: SQSClient;
  /** Receives and deletes until the queue stays empty for `idleRounds` polls. */
  drain(idleRounds?: number): Promise<ReceivedMessage[]>;
  close(): Promise<void>;
}

/**
 * Disposable FIFO queue on the real SQS emulator (requires `docker compose up -d sqs`).
 * Content-based deduplication is off: deduplication comes only from the publisher's ids.
 */
export async function createTestQueue(env: Env, suite: string): Promise<TestQueue> {
  const sqs = createSqsClient(env);
  const name = `test-${suite.replace(/[^a-z0-9-]/gi, '-')}-${crypto.randomUUID().slice(0, 8)}.fifo`;
  const { QueueUrl } = await sqs.send(
    new CreateQueueCommand({
      QueueName: name,
      Attributes: { FifoQueue: 'true', ContentBasedDeduplication: 'false' },
    }),
  );
  if (!QueueUrl) throw new Error('queue creation returned no URL');

  return {
    name,
    url: QueueUrl,
    sqs,
    async drain(idleRounds = 2) {
      const received: ReceivedMessage[] = [];
      let idle = 0;
      while (idle < idleRounds) {
        const { Messages = [] } = await sqs.send(
          new ReceiveMessageCommand({
            QueueUrl,
            MaxNumberOfMessages: 10,
            WaitTimeSeconds: 1,
            MessageSystemAttributeNames: ['MessageGroupId', 'MessageDeduplicationId'],
            MessageAttributeNames: ['All'],
          }),
        );
        if (Messages.length === 0) {
          idle++;
          continue;
        }
        idle = 0;
        for (const message of Messages) {
          received.push({
            body: JSON.parse(message.Body ?? '{}') as Record<string, unknown>,
            groupId: message.Attributes?.MessageGroupId,
            deduplicationId: message.Attributes?.MessageDeduplicationId,
            eventType: message.MessageAttributes?.eventType?.StringValue,
          });
          await sqs.send(
            new DeleteMessageCommand({ QueueUrl, ReceiptHandle: message.ReceiptHandle }),
          );
        }
      }
      return received;
    },
    async close() {
      await sqs.send(new DeleteQueueCommand({ QueueUrl })).catch(() => undefined);
      sqs.destroy();
    },
  };
}
