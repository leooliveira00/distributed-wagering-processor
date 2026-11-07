/**
 * Creates the SQS queues used by the service. Idempotent: CreateQueue returns the existing
 * queue when called again with the same attributes, so it is safe to run on every startup.
 * Uses only the AWS SDK, so it works the same against MiniStack, LocalStack or real AWS.
 */
import { CreateQueueCommand, GetQueueAttributesCommand, type SQSClient } from '@aws-sdk/client-sqs';
import { loadEnv } from '../src/infrastructure/config/env';
import { createSqsClient } from '../src/infrastructure/messaging/sqs/sqs-client';

const VISIBILITY_TIMEOUT_SECONDS = '30';
const DLQ_RETENTION_SECONDS = '1209600'; // 14 days, the SQS maximum, to keep failures auditable.

async function createFifoQueue(
  sqs: SQSClient,
  name: string,
  attributes: Record<string, string>,
): Promise<string> {
  const { QueueUrl } = await sqs.send(
    new CreateQueueCommand({ QueueName: name, Attributes: { FifoQueue: 'true', ...attributes } }),
  );
  if (!QueueUrl) throw new Error(`CreateQueue returned no URL for ${name}`);
  return QueueUrl;
}

async function getQueueArn(sqs: SQSClient, queueUrl: string): Promise<string> {
  const { Attributes } = await sqs.send(
    new GetQueueAttributesCommand({ QueueUrl: queueUrl, AttributeNames: ['QueueArn'] }),
  );
  const arn = Attributes?.QueueArn;
  if (!arn) throw new Error(`Queue ${queueUrl} has no QueueArn attribute`);
  return arn;
}

const MAX_ATTEMPTS = 30;
const RETRY_DELAY_MS = 1000;

async function withRetry<T>(operation: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await operation();
    } catch (error) {
      if (attempt >= MAX_ATTEMPTS) throw error;
      console.log(`SQS not reachable yet (attempt ${attempt}/${MAX_ATTEMPTS}), retrying...`);
      await Bun.sleep(RETRY_DELAY_MS);
    }
  }
}

const env = loadEnv();
const sqs = createSqsClient(env);

try {
  const dlqUrl = await withRetry(() =>
    createFifoQueue(sqs, env.SQS_WAGER_DLQ_NAME, { MessageRetentionPeriod: DLQ_RETENTION_SECONDS }),
  );
  const dlqArn = await getQueueArn(sqs, dlqUrl);

  const wagerQueueUrl = await createFifoQueue(sqs, env.SQS_WAGER_QUEUE_NAME, {
    VisibilityTimeout: VISIBILITY_TIMEOUT_SECONDS,
    // Broker-level dedup is only an optimization; the persistent inbox is the real guarantee.
    ContentBasedDeduplication: 'true',
    RedrivePolicy: JSON.stringify({
      deadLetterTargetArn: dlqArn,
      maxReceiveCount: String(env.SQS_MAX_RECEIVE_COUNT),
    }),
  });

  // Outbox publisher sets MessageDeduplicationId = eventId explicitly.
  const eventsQueueUrl = await createFifoQueue(sqs, env.SQS_EVENTS_QUEUE_NAME, {
    ContentBasedDeduplication: 'false',
  });

  console.log('SQS queues ready:');
  for (const url of [wagerQueueUrl, dlqUrl, eventsQueueUrl]) console.log(`  - ${url}`);
} finally {
  sqs.destroy();
}
