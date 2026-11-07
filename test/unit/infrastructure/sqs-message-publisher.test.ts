import {
  GetQueueUrlCommand,
  SendMessageBatchCommand,
  type SendMessageBatchCommandOutput,
  type SQSClient,
} from '@aws-sdk/client-sqs';
import { describe, expect, it } from 'bun:test';
import { OutboxMessage } from '../../../src/domain/messaging/outbox-message';
import { SqsMessagePublisher } from '../../../src/infrastructure/messaging/sqs/sqs-message-publisher';

const message = (id: string, walletId: string) =>
  OutboxMessage.rehydrate({
    id,
    aggregateId: `tx-${id}`,
    eventType: 'WagerTransactionProcessed',
    payload: { eventId: id, data: { walletId } },
    occurredAt: new Date(),
    attempts: 0,
    nextAttemptAt: undefined,
    publishedAt: undefined,
  });

/** An SQS client that records the batches sent and answers with the given outcome. */
function fakeSqs(answer: Partial<SendMessageBatchCommandOutput>) {
  const batches: SendMessageBatchCommand[] = [];
  const sqs = {
    send(command: unknown) {
      if (command instanceof GetQueueUrlCommand) return Promise.resolve({ QueueUrl: 'q-url' });
      if (command instanceof SendMessageBatchCommand) {
        batches.push(command);
        return Promise.resolve(answer);
      }
      return Promise.reject(new Error('unexpected command'));
    },
  } as unknown as SQSClient;
  return { sqs, batches };
}

describe('SqsMessagePublisher.publishBatch', () => {
  it('sends one SendMessageBatch, in order, grouped by wallet and deduplicated by event id', async () => {
    const { sqs, batches } = fakeSqs({
      Successful: [{ Id: '0' }, { Id: '1' }].map((entry) => ({
        ...entry,
        MessageId: 'm',
        MD5OfMessageBody: 'x',
      })),
    });

    const result = await new SqsMessagePublisher(sqs, 'events.fifo').publishBatch([
      message('e1', 'w1'),
      message('e2', 'w2'),
    ]);

    expect(result.failed).toEqual([]);
    expect(batches).toHaveLength(1);
    expect(
      batches[0]?.input.Entries?.map((entry) => [
        entry.Id,
        entry.MessageGroupId,
        entry.MessageDeduplicationId,
      ]),
    ).toEqual([
      ['0', 'w1', 'e1'],
      ['1', 'w2', 'e2'],
    ]);
  });

  it('reports rejected entries, and entries the broker did not mention, as failed', async () => {
    const { sqs } = fakeSqs({
      Successful: [{ Id: '0', MessageId: 'm', MD5OfMessageBody: 'x' }],
      Failed: [{ Id: '1', Code: 'InternalError', SenderFault: false }],
      // entry '2' is in neither list: without a confirmation it must not count as published
    });

    const result = await new SqsMessagePublisher(sqs, 'events.fifo').publishBatch([
      message('e1', 'w1'),
      message('e2', 'w1'),
      message('e3', 'w1'),
    ]);

    expect(result.failed).toEqual([
      { messageId: 'e2', error: 'InternalError' },
      { messageId: 'e3', error: 'not confirmed by the broker' },
    ]);
  });

  it('refuses a batch larger than the SQS limit instead of truncating it', () => {
    const { sqs } = fakeSqs({});
    const tooMany = Array.from({ length: 11 }, (_, index) => message(`e${String(index)}`, 'w1'));

    expect(new SqsMessagePublisher(sqs, 'events.fifo').publishBatch(tooMany)).rejects.toThrow(
      'at most 10',
    );
  });
});
