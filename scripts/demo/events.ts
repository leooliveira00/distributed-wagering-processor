/**
 * README §11, live: reads the integration events the outbox published to `wagering-events.fifo`
 * and prints them. It CONSUMES them (receive + delete), like a downstream consumer would, so a
 * second run only shows events published since the first one.
 *
 *   bun run demo:events
 */
import {
  DeleteMessageCommand,
  GetQueueUrlCommand,
  ReceiveMessageCommand,
} from '@aws-sdk/client-sqs';
import { demoEnv, demoSqs } from './shared';

interface EventEnvelope {
  eventId: string;
  eventType: string;
  aggregateId: string;
  occurredAt: string;
  data: { walletId?: string; kind?: string; status?: string; failureCode?: string };
}

const env = demoEnv();
const sqs = demoSqs(env);
const { QueueUrl } = await sqs.send(
  new GetQueueUrlCommand({ QueueName: env.SQS_EVENTS_QUEUE_NAME }),
);

const events: EventEnvelope[] = [];
for (let idle = 0; idle < 2;) {
  const { Messages = [] } = await sqs.send(
    new ReceiveMessageCommand({ QueueUrl, MaxNumberOfMessages: 10, WaitTimeSeconds: 1 }),
  );
  if (Messages.length === 0) {
    idle++;
    continue;
  }
  idle = 0;
  for (const message of Messages) {
    events.push(JSON.parse(message.Body ?? '{}') as EventEnvelope);
    await sqs.send(new DeleteMessageCommand({ QueueUrl, ReceiptHandle: message.ReceiptHandle }));
  }
}

if (events.length === 0) {
  console.log(`No events waiting in ${env.SQS_EVENTS_QUEUE_NAME}.`);
} else {
  console.table(
    events.map((event) => ({
      eventType: event.eventType,
      wallet: (event.data.walletId ?? event.aggregateId).slice(0, 8),
      kind: event.data.kind ?? '',
      status: event.data.status ?? '',
      failureCode: event.data.failureCode ?? '',
      // The tail of a UUIDv7 is random; its head is a timestamp, nearly equal between events.
      eventId: `…${event.eventId.slice(-12)}`,
      occurredAt: event.occurredAt,
    })),
  );
  console.log(`${String(events.length)} events consumed from ${env.SQS_EVENTS_QUEUE_NAME}.`);
}
sqs.destroy();
