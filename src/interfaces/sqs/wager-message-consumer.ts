import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  GetQueueUrlCommand,
  type Message,
  ReceiveMessageCommand,
  SendMessageCommand,
  type SQSClient,
} from '@aws-sdk/client-sqs';
import { type FaultInjector } from '../../application/ports/fault-injector';
import { type AppLogger, type LogFields } from '../../application/ports/logger';
import { type Metrics } from '../../application/ports/metrics';
import { type SubmitWagerTransaction } from '../../application/wagering/submit-wager-transaction';
import { type WagerSubmissionResult } from '../../application/wagering/wager-views';
import { backoffDelayMs, type BackoffPolicy } from '../../domain/shared/backoff';
import { isSafeCorrelationId, wagerMessageSchema } from '../contracts/wager-contract';
import { type Disposition, dispositionOfError, dispositionOfResult } from './message-disposition';

export interface WagerConsumerOptions {
  /** Inbox key namespace: every instance of this consumer shares it. */
  consumerName: string;
  queueName: string;
  deadLetterQueueName: string;
  batchSize: number;
  waitTimeSeconds: number;
  retry: BackoffPolicy;
  shutdownTimeoutMs: number;
  idleOnErrorMs: number;
}

/** SQS caps a visibility timeout at 12 hours. */
const MAX_VISIBILITY_SECONDS = 43_200;

interface Decision {
  disposition: Disposition;
  fields: LogFields;
}

/**
 * Consumes `wager-transactions.fifo` (README §10) through the SAME use case as HTTP.
 *
 * - Deduplication: persistent inbox keyed by (consumerName, messageId), written in the same SQL
 *   transaction as the financial change.
 * - Ack only after commit: the message is deleted after the use case returned.
 * - Business outcome -> ack; transient failure -> exponential backoff via the visibility timeout;
 *   permanent failure -> DLQ immediately; retries are capped by the queue redrive policy.
 * - Ordering: messages of one MessageGroupId are handled sequentially, groups in parallel.
 * - SIGTERM: stops receiving, lets in-flight messages finish within the shutdown timeout and
 *   returns the visibility of anything not finished, so another instance takes it at once.
 */
export class WagerMessageConsumer {
  private stopping = false;
  private loop: Promise<void> | undefined;
  private receiveAbort: AbortController | undefined;
  private queues: Promise<{ main: string; deadLetter: string }> | undefined;
  private readonly inFlight = new Map<string, Message>();

  constructor(
    private readonly sqs: SQSClient,
    private readonly submit: SubmitWagerTransaction,
    private readonly metrics: Metrics,
    private readonly logger: AppLogger,
    private readonly faults: FaultInjector,
    private readonly options: WagerConsumerOptions,
  ) {}

  start(): void {
    if (this.loop) return;
    this.stopping = false;
    this.loop = this.run();
    this.logger.info('Worker started', { worker: 'sqs-consumer', queue: this.options.queueName });
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.receiveAbort?.abort();
    const finished = await Promise.race([
      (this.loop ?? Promise.resolve()).then(() => true),
      Bun.sleep(this.options.shutdownTimeoutMs).then(() => false),
    ]);
    if (!finished) {
      // Still processing after the grace period: hand the messages back to the queue now.
      await this.release([...this.inFlight.values()]);
    }
    this.loop = undefined;
    this.logger.info('Worker stopped', { worker: 'sqs-consumer', drained: finished });
  }

  /** One receive-and-handle cycle. Returns how many messages were received. */
  async pollOnce(): Promise<number> {
    const { main } = await this.resolveQueues();
    this.receiveAbort = new AbortController();
    const { Messages = [] } = await this.sqs.send(
      new ReceiveMessageCommand({
        QueueUrl: main,
        MaxNumberOfMessages: this.options.batchSize,
        WaitTimeSeconds: this.options.waitTimeSeconds,
        MessageSystemAttributeNames: ['ApproximateReceiveCount', 'MessageGroupId'],
        MessageAttributeNames: ['All'],
      }),
      { abortSignal: this.receiveAbort.signal },
    );
    if (Messages.length === 0) return 0;
    this.metrics.increment('sqs_messages_received_total', {}, Messages.length);

    await Promise.all(groupByMessageGroup(Messages).map((group) => this.handleGroup(group)));
    return Messages.length;
  }

  private async run(): Promise<void> {
    while (!this.isStopping()) {
      try {
        await this.pollOnce();
      } catch (error) {
        if (this.isStopping()) break; // receive aborted by stop()
        this.logger.error('Consumer poll failed', {
          worker: 'sqs-consumer',
          error: error instanceof Error ? error.message : String(error),
        });
        await Bun.sleep(this.options.idleOnErrorMs);
      }
    }
  }

  /** Sequential within a FIFO group (preserves per-wallet order). */
  private async handleGroup(messages: Message[]): Promise<void> {
    for (const [index, message] of messages.entries()) {
      if (this.isStopping()) {
        await this.release(messages.slice(index));
        return;
      }
      await this.handle(message);
    }
  }

  private async handle(message: Message): Promise<void> {
    const handle = message.ReceiptHandle ?? '';
    this.inFlight.set(handle, message);
    try {
      const { disposition, fields } = await this.decide(message);
      await this.apply(message, disposition, fields);
    } catch (error) {
      // Acting on the broker failed (e.g. delete): the message reappears and the inbox dedups it.
      this.logger.error('Failed to settle message', {
        sqsMessageId: message.MessageId,
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      this.inFlight.delete(handle);
    }
  }

  private async decide(message: Message): Promise<Decision> {
    const base: LogFields = { sqsMessageId: message.MessageId };

    let raw: unknown;
    try {
      raw = JSON.parse(message.Body ?? '');
    } catch {
      return {
        disposition: { action: 'dead-letter', reason: 'malformed_message', code: 'MALFORMED_JSON' },
        fields: base,
      };
    }
    const envelope = wagerMessageSchema.safeParse(raw);
    if (!envelope.success) {
      return {
        disposition: { action: 'dead-letter', reason: 'invalid_payload', code: 'INVALID_PAYLOAD' },
        fields: base,
      };
    }

    const { messageId, data } = envelope.data;
    const correlationAttribute = message.MessageAttributes?.correlationId?.StringValue;
    const correlationId = isSafeCorrelationId(correlationAttribute)
      ? correlationAttribute
      : isSafeCorrelationId(messageId)
        ? messageId
        : (message.MessageId ?? messageId);
    const fields: LogFields = {
      ...base,
      messageId,
      correlationId,
      providerId: data.providerId,
      walletId: data.walletId,
    };

    let result: WagerSubmissionResult;
    try {
      result = await this.submit.execute(
        data,
        { correlationId, causationId: messageId },
        { consumerName: this.options.consumerName, messageId },
      );
    } catch (error) {
      return { disposition: dispositionOfError(error), fields };
    }
    // Committed, not acked yet: the window README §13.5 asks to survive.
    this.faults.trigger('consumer:after-commit');
    return {
      disposition: dispositionOfResult(result),
      fields: { ...fields, transactionId: result.transactionId, status: result.status },
    };
  }

  private async apply(
    message: Message,
    disposition: Disposition,
    fields: LogFields,
  ): Promise<void> {
    const { main, deadLetter } = await this.resolveQueues();

    switch (disposition.action) {
      case 'ack': {
        await this.sqs.send(
          new DeleteMessageCommand({ QueueUrl: main, ReceiptHandle: message.ReceiptHandle }),
        );
        this.metrics.increment('sqs_messages_processed_total', { outcome: disposition.outcome });
        if (disposition.outcome === 'duplicate') {
          this.metrics.increment('sqs_duplicate_messages_total');
        }
        if (disposition.outcome === 'conflict') {
          this.logger.warn('Message conflicts with an existing transaction, acknowledged', fields);
        }
        return;
      }
      case 'retry': {
        const receiveCount = Number(message.Attributes?.ApproximateReceiveCount ?? '1');
        const delaySeconds = Math.min(
          MAX_VISIBILITY_SECONDS,
          Math.ceil(backoffDelayMs(Math.max(receiveCount, 1), this.options.retry) / 1000),
        );
        await this.sqs.send(
          new ChangeMessageVisibilityCommand({
            QueueUrl: main,
            ReceiptHandle: message.ReceiptHandle,
            VisibilityTimeout: delaySeconds,
          }),
        );
        this.metrics.increment('sqs_message_retries_total', { reason: disposition.reason });
        this.logger.warn('Message processing failed, retry scheduled', {
          ...fields,
          code: disposition.code,
          receiveCount,
          retryInSeconds: delaySeconds,
        });
        return;
      }
      case 'dead-letter': {
        await this.sqs.send(
          new SendMessageCommand({
            QueueUrl: deadLetter,
            MessageBody: message.Body ?? '',
            MessageGroupId: message.Attributes?.MessageGroupId ?? 'dead-letter',
            // The original SQS id: moving the same message twice is deduplicated by the broker.
            MessageDeduplicationId: message.MessageId,
            MessageAttributes: {
              deadLetterReason: { DataType: 'String', StringValue: disposition.reason },
              errorCode: { DataType: 'String', StringValue: disposition.code },
            },
          }),
        );
        await this.sqs.send(
          new DeleteMessageCommand({ QueueUrl: main, ReceiptHandle: message.ReceiptHandle }),
        );
        this.metrics.increment('sqs_messages_dead_lettered_total', { reason: disposition.reason });
        this.logger.error('Message moved to the dead-letter queue', {
          ...fields,
          reason: disposition.reason,
          code: disposition.code,
        });
        return;
      }
    }
  }

  /** Makes messages visible again immediately (visibility 0) for another consumer. */
  private async release(messages: Message[]): Promise<void> {
    if (messages.length === 0) return;
    const { main } = await this.resolveQueues();
    await Promise.all(
      messages.map((message) =>
        this.sqs
          .send(
            new ChangeMessageVisibilityCommand({
              QueueUrl: main,
              ReceiptHandle: message.ReceiptHandle,
              VisibilityTimeout: 0,
            }),
          )
          .catch(() => undefined),
      ),
    );
    this.logger.info('Released messages back to the queue', { count: messages.length });
  }

  private resolveQueues(): Promise<{ main: string; deadLetter: string }> {
    this.queues ??= Promise.all([
      this.queueUrl(this.options.queueName),
      this.queueUrl(this.options.deadLetterQueueName),
    ])
      .then(([main, deadLetter]) => ({ main, deadLetter }))
      .catch((error: unknown) => {
        this.queues = undefined;
        throw error;
      });
    return this.queues;
  }

  private async queueUrl(name: string): Promise<string> {
    const { QueueUrl } = await this.sqs.send(new GetQueueUrlCommand({ QueueName: name }));
    if (!QueueUrl) throw new Error(`Queue ${name} has no URL`);
    return QueueUrl;
  }

  private isStopping(): boolean {
    return this.stopping;
  }
}

/** Groups by MessageGroupId, keeping the receive order inside each group. */
function groupByMessageGroup(messages: Message[]): Message[][] {
  const groups = new Map<string, Message[]>();
  for (const message of messages) {
    const key = message.Attributes?.MessageGroupId ?? message.MessageId ?? '';
    const group = groups.get(key);
    if (group) group.push(message);
    else groups.set(key, [message]);
  }
  return [...groups.values()];
}
