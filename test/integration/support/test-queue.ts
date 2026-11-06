import {
  CreateQueueCommand,
  DeleteMessageCommand,
  DeleteQueueCommand,
  GetQueueAttributesCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  type SQSClient,
} from '@aws-sdk/client-sqs';
import { type Env } from '../../../src/infrastructure/config/env';
import { createSqsClient } from '../../../src/infrastructure/messaging/sqs/sqs-client';

export interface ReceivedMessage {
  /** Parsed JSON body, or `{ raw }` when the body is not JSON. */
  body: Record<string, unknown>;
  groupId: string | undefined;
  deduplicationId: string | undefined;
  eventType: string | undefined;
  attributes: Record<string, string | undefined>;
}

export interface SendOptions {
  groupId: string;
  deduplicationId?: string;
  attributes?: Record<string, string>;
}

export interface TestQueue {
  name: string;
  url: string;
  sqs: SQSClient;
  send(body: string | Record<string, unknown>, options: SendOptions): Promise<void>;
  /** Receives and deletes until the queue stays empty for `idleRounds` polls. */
  drain(idleRounds?: number): Promise<ReceivedMessage[]>;
  close(): Promise<void>;
}

export interface QueueOptions {
  visibilityTimeoutSeconds?: number;
  /** Redrive to this queue after `maxReceiveCount` receives. */
  deadLetter?: { arn: string; maxReceiveCount: number };
}

const safeName = (suite: string) =>
  `test-${suite.replace(/[^a-z0-9-]/gi, '-')}-${crypto.randomUUID().slice(0, 8)}.fifo`;

/**
 * Disposable FIFO queue on the real SQS emulator (requires `docker compose up -d sqs`).
 * Content-based deduplication is off: deduplication comes only from explicit ids.
 */
export async function createTestQueue(
  env: Env,
  suite: string,
  options: QueueOptions = {},
): Promise<TestQueue> {
  const sqs = createSqsClient(env);
  const name = safeName(suite);
  const { QueueUrl } = await sqs.send(
    new CreateQueueCommand({
      QueueName: name,
      Attributes: {
        FifoQueue: 'true',
        ContentBasedDeduplication: 'false',
        ...(options.visibilityTimeoutSeconds !== undefined
          ? { VisibilityTimeout: String(options.visibilityTimeoutSeconds) }
          : {}),
        ...(options.deadLetter
          ? {
              RedrivePolicy: JSON.stringify({
                deadLetterTargetArn: options.deadLetter.arn,
                maxReceiveCount: String(options.deadLetter.maxReceiveCount),
              }),
            }
          : {}),
      },
    }),
  );
  if (!QueueUrl) throw new Error('queue creation returned no URL');

  return {
    name,
    url: QueueUrl,
    sqs,
    async send(body, sendOptions) {
      await sqs.send(
        new SendMessageCommand({
          QueueUrl,
          MessageBody: typeof body === 'string' ? body : JSON.stringify(body),
          MessageGroupId: sendOptions.groupId,
          MessageDeduplicationId: sendOptions.deduplicationId ?? crypto.randomUUID(),
          ...(sendOptions.attributes
            ? {
                MessageAttributes: Object.fromEntries(
                  Object.entries(sendOptions.attributes).map(([key, value]) => [
                    key,
                    { DataType: 'String', StringValue: value },
                  ]),
                ),
              }
            : {}),
        }),
      );
    },
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
          let body: Record<string, unknown>;
          try {
            body = JSON.parse(message.Body ?? '{}') as Record<string, unknown>;
          } catch {
            body = { raw: message.Body };
          }
          received.push({
            body,
            groupId: message.Attributes?.MessageGroupId,
            deduplicationId: message.Attributes?.MessageDeduplicationId,
            eventType: message.MessageAttributes?.eventType?.StringValue,
            attributes: Object.fromEntries(
              Object.entries(message.MessageAttributes ?? {}).map(([key, value]) => [
                key,
                value.StringValue,
              ]),
            ),
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

export interface QueuePair {
  main: TestQueue;
  deadLetter: TestQueue;
  close(): Promise<void>;
}

/** Main queue + DLQ wired by a redrive policy, like `wager-transactions(.dlq).fifo`. */
export async function createQueuePair(
  env: Env,
  suite: string,
  options: { visibilityTimeoutSeconds: number; maxReceiveCount: number },
): Promise<QueuePair> {
  const deadLetter = await createTestQueue(env, `${suite}-dlq`);
  const { Attributes } = await deadLetter.sqs.send(
    new GetQueueAttributesCommand({ QueueUrl: deadLetter.url, AttributeNames: ['QueueArn'] }),
  );
  const arn = Attributes?.QueueArn;
  if (!arn) throw new Error('dead-letter queue has no ARN');
  const main = await createTestQueue(env, suite, {
    visibilityTimeoutSeconds: options.visibilityTimeoutSeconds,
    deadLetter: { arn, maxReceiveCount: options.maxReceiveCount },
  });
  return {
    main,
    deadLetter,
    async close() {
      await main.close();
      await deadLetter.close();
    },
  };
}
