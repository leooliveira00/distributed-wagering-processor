import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  ReceiveMessageCommand,
  type Message,
} from '@aws-sdk/client-sqs';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test';
import { createTestDatabase, type TestDatabase } from '../support/test-database';
import { createQueuePair, type QueuePair, type TestQueue } from '../support/test-queue';

/**
 * Contract of the SQS emulator (MiniStack, or LocalStack via the override file): the broker
 * semantics this system relies on. If the emulator changes or is swapped, this suite says whether
 * the consumer and the outbox tests still prove what they claim.
 */
let db: TestDatabase;
const pairs: QueuePair[] = [];

beforeAll(async () => {
  db = await createTestDatabase('emulator_contract');
});

afterEach(async () => {
  for (const pair of pairs.splice(0)) await pair.close();
});

afterAll(async () => {
  await db.close();
});

async function pair(name: string, maxReceiveCount = 3): Promise<QueuePair> {
  const created = await createQueuePair(db.env, `contract-${name}`, {
    visibilityTimeoutSeconds: 30,
    maxReceiveCount,
  });
  pairs.push(created);
  return created;
}

async function receive(queue: TestQueue, visibilityTimeout: number, max = 10): Promise<Message[]> {
  const { Messages = [] } = await queue.sqs.send(
    new ReceiveMessageCommand({
      QueueUrl: queue.url,
      MaxNumberOfMessages: max,
      WaitTimeSeconds: 1,
      VisibilityTimeout: visibilityTimeout,
      MessageSystemAttributeNames: ['ApproximateReceiveCount', 'MessageGroupId'],
    }),
  );
  return Messages;
}

describe('SQS emulator contract', () => {
  it('drops a message whose MessageDeduplicationId was already sent (outbox republication)', async () => {
    const { main } = await pair('dedup');
    await main.send({ n: 1 }, { groupId: 'g', deduplicationId: 'same-event' });
    await main.send({ n: 1 }, { groupId: 'g', deduplicationId: 'same-event' });

    expect(await main.drain()).toHaveLength(1);
  }, 30_000);

  it('delivers messages of a group in order', async () => {
    const { main } = await pair('order');
    for (const n of [1, 2, 3]) await main.send({ n }, { groupId: 'g' });

    const received = await main.drain();

    expect(received.map((message) => message.body.n)).toEqual([1, 2, 3]);
  }, 30_000);

  it('holds back the rest of a group while one of its messages is in flight', async () => {
    const { main } = await pair('group-blocking');
    await main.send({ n: 1 }, { groupId: 'g' });
    await main.send({ n: 2 }, { groupId: 'g' });

    const first = await receive(main, 30, 1);
    const whileInFlight = await receive(main, 30);

    expect(first).toHaveLength(1);
    expect(whileInFlight).toHaveLength(0);
  }, 30_000);

  it('redelivers a message whose visibility timeout expired (ack only after commit)', async () => {
    const { main } = await pair('visibility');
    await main.send({ n: 1 }, { groupId: 'g' });

    await receive(main, 1);
    await Bun.sleep(1_500);
    const redelivered = await receive(main, 30);

    expect(redelivered).toHaveLength(1);
    expect(redelivered[0]?.Attributes?.ApproximateReceiveCount).toBe('2');
  }, 30_000);

  it('makes a message visible again at once with ChangeMessageVisibility(0) (SIGTERM release)', async () => {
    const { main } = await pair('release');
    await main.send({ n: 1 }, { groupId: 'g' });
    const [message] = await receive(main, 30);

    await main.sqs.send(
      new ChangeMessageVisibilityCommand({
        QueueUrl: main.url,
        ReceiptHandle: message?.ReceiptHandle,
        VisibilityTimeout: 0,
      }),
    );

    expect(await receive(main, 30)).toHaveLength(1);
  }, 30_000);

  it('does not redeliver a deleted message (ack)', async () => {
    const { main } = await pair('delete');
    await main.send({ n: 1 }, { groupId: 'g' });
    const [message] = await receive(main, 1);

    await main.sqs.send(
      new DeleteMessageCommand({ QueueUrl: main.url, ReceiptHandle: message?.ReceiptHandle }),
    );
    await Bun.sleep(1_500);

    expect(await receive(main, 30)).toHaveLength(0);
  }, 30_000);

  it('moves a message to the DLQ after maxReceiveCount receives (redrive policy)', async () => {
    const { main, deadLetter } = await pair('redrive', 2);
    await main.send({ n: 1 }, { groupId: 'g' });

    for (let attempt = 0; attempt < 4; attempt++) {
      await receive(main, 1);
      await Bun.sleep(1_200);
    }

    expect(await deadLetter.drain()).toHaveLength(1);
    expect(await main.drain()).toHaveLength(0);
  }, 30_000);
});
