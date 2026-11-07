import { GetQueueAttributesCommand } from '@aws-sdk/client-sqs';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test';
import { TransientError } from '../../../src/application/errors';
import {
  type TransactionScope,
  type UnitOfWork,
  type UnitOfWorkOptions,
} from '../../../src/application/ports/unit-of-work';
import { SubmitWagerTransaction } from '../../../src/application/wagering/submit-wager-transaction';
import { CreateWallet } from '../../../src/application/wallets/create-wallet';
import { type WalletView } from '../../../src/application/wallets/wallet-views';
import { PrometheusMetrics } from '../../../src/infrastructure/observability/prometheus-metrics';
import { MikroOrmUnitOfWork } from '../../../src/infrastructure/persistence/mikro-orm-unit-of-work';
import { SystemClock, UuidV7IdGenerator } from '../../../src/infrastructure/system/system.adapters';
import { WagerMessageConsumer } from '../../../src/interfaces/sqs/wager-message-consumer';
import { expectLedgerConsistent } from '../support/invariants';
import { createTestDatabase, type TestDatabase } from '../support/test-database';
import { createQueuePair, type QueuePair, type TestQueue } from '../support/test-queue';
import { RecordingLogger } from '../support/test-loggers';

const CONSUMER_NAME = 'wager-transactions-consumer';
const MAX_RECEIVE_COUNT = 3;

/** Real unit of work that can fail transiently or slow down on demand (database stays real). */
class ControlledUnitOfWork implements UnitOfWork {
  failuresLeft = 0;
  delayMs = 0;
  failure: () => Error = () => new TransientError('database unavailable (simulated)');

  constructor(private readonly inner: UnitOfWork) {}

  async run<T>(work: (scope: TransactionScope) => Promise<T>, options?: UnitOfWorkOptions) {
    if (this.failuresLeft > 0) {
      this.failuresLeft--;
      throw this.failure();
    }
    if (this.delayMs > 0) await Bun.sleep(this.delayMs);
    return this.inner.run(work, options);
  }
}

let db: TestDatabase;
let realUnitOfWork: UnitOfWork;
let createWallet: CreateWallet;
const pairs: QueuePair[] = [];

beforeAll(async () => {
  db = await createTestDatabase('sqs_consumer');
  realUnitOfWork = new MikroOrmUnitOfWork(db.orm);
  createWallet = new CreateWallet(realUnitOfWork, new UuidV7IdGenerator(), new SystemClock());
});

afterEach(async () => {
  for (const pair of pairs.splice(0)) await pair.close();
});

afterAll(async () => {
  await db.close();
});

interface Harness {
  queues: QueuePair;
  unitOfWork: ControlledUnitOfWork;
  metrics: PrometheusMetrics;
  logger: RecordingLogger;
  consumer: WagerMessageConsumer;
}

async function harness(name: string, visibilityTimeoutSeconds = 2): Promise<Harness> {
  const queues = await createQueuePair(db.env, name, {
    visibilityTimeoutSeconds,
    maxReceiveCount: MAX_RECEIVE_COUNT,
  });
  pairs.push(queues);
  const unitOfWork = new ControlledUnitOfWork(realUnitOfWork);
  const metrics = new PrometheusMetrics();
  const logger = new RecordingLogger();
  const submit = new SubmitWagerTransaction(
    unitOfWork,
    new UuidV7IdGenerator(),
    new SystemClock(),
    {
      backoff: { baseMs: 1_000, capMs: 60_000 },
      maxAttempts: 10,
    },
    metrics,
  );
  const consumer = new WagerMessageConsumer(
    queues.main.sqs,
    submit,
    metrics,
    logger,
    { trigger: () => undefined },
    {
      consumerName: CONSUMER_NAME,
      queueName: queues.main.name,
      deadLetterQueueName: queues.deadLetter.name,
      batchSize: 10,
      waitTimeSeconds: 1,
      retry: { baseMs: 1_000, capMs: 1_000 },
      shutdownTimeoutMs: 5_000,
      idleOnErrorMs: 100,
    },
  );
  return { queues, unitOfWork, metrics, logger, consumer };
}

const openWallet = (amount = '100.00'): Promise<WalletView> =>
  createWallet.execute(
    { playerId: crypto.randomUUID(), initialBalance: { amount, currency: 'BRL' } },
    { correlationId: 'corr-sqs' },
  );

/** README §10 message for the given wallet. */
function wagerMessage(wallet: WalletView, data: Record<string, unknown> = {}) {
  const externalTransactionId = `tx-${crypto.randomUUID()}`;
  return {
    messageId: `msg-${crypto.randomUUID()}`,
    type: 'WagerTransactionRequested',
    occurredAt: new Date().toISOString(),
    data: {
      providerId: 'provider-a',
      externalTransactionId,
      idempotencyKey: `provider-a:${externalTransactionId}`,
      playerId: wallet.playerId,
      walletId: wallet.id,
      roundId: 'round-987',
      gameId: 'fortune-chimp',
      kind: 'BET',
      money: { amount: '25.00', currency: 'BRL' },
      ...data,
    },
  };
}

/** Messages visible right now (not in flight). */
async function visibleCount(queue: TestQueue): Promise<number> {
  const { Attributes } = await queue.sqs.send(
    new GetQueueAttributesCommand({
      QueueUrl: queue.url,
      AttributeNames: ['ApproximateNumberOfMessages'],
    }),
  );
  return Number(Attributes?.ApproximateNumberOfMessages ?? '0');
}

/** Visible + in-flight messages: both zero only once every message was deleted. */
async function depth(queue: TestQueue): Promise<number> {
  const { Attributes } = await queue.sqs.send(
    new GetQueueAttributesCommand({
      QueueUrl: queue.url,
      AttributeNames: ['ApproximateNumberOfMessages', 'ApproximateNumberOfMessagesNotVisible'],
    }),
  );
  return (
    Number(Attributes?.ApproximateNumberOfMessages ?? '0') +
    Number(Attributes?.ApproximateNumberOfMessagesNotVisible ?? '0')
  );
}

const transactionsOf = async (walletId: string) =>
  (await db.sql.unsafe(
    `select status, failure_code from wager_transactions
      where wallet_id = $1 and kind <> 'OPENING' order by created_at`,
    [walletId],
  )) as { status: string; failure_code: string | null }[];

const inboxRows = async (messageId: string) =>
  (
    (await db.sql.unsafe(
      'select 1 from inbox_messages where consumer_name = $1 and message_id = $2',
      [CONSUMER_NAME, messageId],
    )) as unknown[]
  ).length;

describe('WagerMessageConsumer — acknowledged outcomes', () => {
  it('processes a valid message, records it in the inbox and deletes it after the commit', async () => {
    const { queues, consumer, metrics } = await harness('ok');
    const wallet = await openWallet('100.00');
    const message = wagerMessage(wallet);
    await queues.main.send(message, { groupId: wallet.id });

    expect(await consumer.pollOnce()).toBe(1);

    expect(await transactionsOf(wallet.id)).toEqual([{ status: 'PROCESSED', failure_code: null }]);
    expect(await inboxRows(message.messageId)).toBe(1);
    expect(await depth(queues.main)).toBe(0);
    expect(await depth(queues.deadLetter)).toBe(0);
    expect(
      await metrics.counterValue('sqs_messages_processed_total', { outcome: 'processed' }),
    ).toBe(1);
    expect(
      await metrics.counterValue('wager_transactions_total', {
        kind: 'BET',
        status: 'PROCESSED',
        source: 'submission',
      }),
    ).toBe(1);
    expect(
      await metrics.observationCount('wager_processing_duration_seconds', {
        entrypoint: 'sqs',
        outcome: 'processed',
      }),
    ).toBe(1);
    await expectLedgerConsistent(db.sql, wallet.id);
  }, 30_000);

  it('applies a redelivered message (same messageId) only once', async () => {
    const { queues, consumer, metrics } = await harness('redelivery');
    const wallet = await openWallet('100.00');
    const message = wagerMessage(wallet);
    // The producer sends the same message twice (new SQS deduplication id each time).
    await queues.main.send(message, { groupId: wallet.id });
    await queues.main.send(message, { groupId: wallet.id });

    let received = 0;
    while (received < 2) received += await consumer.pollOnce();

    expect(await transactionsOf(wallet.id)).toHaveLength(1);
    expect(await inboxRows(message.messageId)).toBe(1);
    expect(await metrics.counterValue('sqs_duplicate_messages_total')).toBe(1);
    expect(
      await metrics.counterValue('wager_idempotent_replays_total', { entrypoint: 'sqs' }),
    ).toBe(1);
    expect(await depth(queues.main)).toBe(0);
    await expectLedgerConsistent(db.sql, wallet.id);
  }, 30_000);

  it('acknowledges a business rejection: persisted, auditable, not dead-lettered', async () => {
    const { queues, consumer } = await harness('rejected');
    const wallet = await openWallet('10.00');
    await queues.main.send(wagerMessage(wallet), { groupId: wallet.id });

    await consumer.pollOnce();

    expect(await transactionsOf(wallet.id)).toEqual([
      { status: 'REJECTED', failure_code: 'INSUFFICIENT_FUNDS' },
    ]);
    expect(await depth(queues.main)).toBe(0);
    expect(await depth(queues.deadLetter)).toBe(0);
  }, 30_000);

  it('acknowledges an idempotency conflict and keeps the original intact', async () => {
    const { queues, consumer, metrics, logger } = await harness('conflict');
    const wallet = await openWallet('100.00');
    const original = wagerMessage(wallet);
    const conflicting = {
      ...wagerMessage(wallet),
      data: { ...original.data, money: { amount: '99.00', currency: 'BRL' } },
    };
    await queues.main.send(original, { groupId: wallet.id });
    await queues.main.send(conflicting, { groupId: wallet.id });

    let received = 0;
    while (received < 2) received += await consumer.pollOnce();

    expect(await transactionsOf(wallet.id)).toEqual([{ status: 'PROCESSED', failure_code: null }]);
    expect(
      await metrics.counterValue('sqs_messages_processed_total', { outcome: 'conflict' }),
    ).toBe(1);
    expect(await depth(queues.main)).toBe(0);
    expect(await depth(queues.deadLetter)).toBe(0);
    await expectLedgerConsistent(db.sql, wallet.id);
    // The warning carries the scope of the message it is about (README §12).
    const warning = logger.warnings.find((line) => line.message.startsWith('Message conflicts'));
    expect(warning?.context).toEqual({
      messageId: conflicting.messageId,
      correlationId: conflicting.messageId,
      providerId: 'provider-a',
      walletId: wallet.id,
    });
  }, 30_000);
});

describe('WagerMessageConsumer — dead letters', () => {
  it.each([
    ['malformed JSON', () => '{not json', 'malformed_message', 'MALFORMED_JSON'],
    [
      'an envelope outside the contract',
      (wallet: WalletView) => ({ ...wagerMessage(wallet), type: 'SomethingElse' }),
      'invalid_payload',
      'INVALID_PAYLOAD',
    ],
    [
      'an amount with one decimal',
      (wallet: WalletView) => wagerMessage(wallet, { money: { amount: '25.5', currency: 'BRL' } }),
      'invalid_payload',
      'INVALID_MONEY',
    ],
    [
      'the reserved internal provider',
      (wallet: WalletView) => wagerMessage(wallet, { providerId: 'internal' }),
      'invalid_payload',
      'RESERVED_PROVIDER',
    ],
    [
      'an unknown wallet',
      (wallet: WalletView) => wagerMessage(wallet, { walletId: crypto.randomUUID() }),
      'wallet_not_found',
      'WALLET_NOT_FOUND',
    ],
  ] as const)(
    'moves %s to the DLQ immediately, with the reason',
    async (_, build, reason, code) => {
      const { queues, consumer, metrics } = await harness(`dlq-${code.toLowerCase()}`);
      const wallet = await openWallet('100.00');
      await queues.main.send(build(wallet), { groupId: wallet.id });

      expect(await consumer.pollOnce()).toBe(1);

      const deadLetters = await queues.deadLetter.drain();
      expect(deadLetters).toHaveLength(1);
      expect(deadLetters[0]?.attributes).toMatchObject({
        deadLetterReason: reason,
        errorCode: code,
      });
      expect(await depth(queues.main)).toBe(0);
      expect(await transactionsOf(wallet.id)).toEqual([]);
      expect(await metrics.counterValue('sqs_messages_dead_lettered_total', { reason })).toBe(1);
    },
    30_000,
  );
});

describe('WagerMessageConsumer — transient failures', () => {
  it('retries with backoff and processes the message once the failure is gone', async () => {
    const { queues, consumer, unitOfWork, metrics } = await harness('retry');
    const wallet = await openWallet('100.00');
    await queues.main.send(wagerMessage(wallet), { groupId: wallet.id });
    unitOfWork.failuresLeft = 1;

    await consumer.pollOnce(); // fails transiently: visibility set to 1 s, not deleted
    const afterFailure = await depth(queues.main);
    await Bun.sleep(1_200);
    let received = 0;
    while (received < 1) received += await consumer.pollOnce();

    expect(afterFailure).toBe(1);
    expect(await metrics.counterValue('sqs_message_retries_total', { reason: 'transient' })).toBe(
      1,
    );
    expect(await transactionsOf(wallet.id)).toEqual([{ status: 'PROCESSED', failure_code: null }]);
    expect(await depth(queues.main)).toBe(0);
    await expectLedgerConsistent(db.sql, wallet.id);
  }, 30_000);

  it('logs the cause of an unexpected failure, with its stack, but never the payload', async () => {
    const { queues, consumer, unitOfWork, logger } = await harness('unexpected-cause');
    const wallet = await openWallet('100.00');
    await queues.main.send(wagerMessage(wallet), { groupId: wallet.id });
    unitOfWork.failuresLeft = 1;
    unitOfWork.failure = () => new Error('bug in the queue path (simulated)');

    await consumer.pollOnce();

    const retry = logger.lines.find(
      (line) => line.message === 'Message processing failed, retry scheduled',
    );
    expect(retry?.fields).toMatchObject({
      code: 'UNEXPECTED_ERROR',
      error: 'bug in the queue path (simulated)',
      errorName: 'Error',
    });
    expect(String(retry?.fields.stack)).toContain('bug in the queue path (simulated)');
    expect(JSON.stringify(retry?.fields)).not.toContain('"amount"');
  }, 30_000);

  it('hands a persistently failing message to the DLQ after the receive limit (redrive)', async () => {
    const { queues, consumer, unitOfWork } = await harness('exhausted');
    const wallet = await openWallet('100.00');
    await queues.main.send(wagerMessage(wallet), { groupId: wallet.id });
    unitOfWork.failuresLeft = Number.POSITIVE_INFINITY;

    let receives = 0;
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline && (await depth(queues.deadLetter)) === 0) {
      receives += await consumer.pollOnce();
      await Bun.sleep(1_100);
    }

    expect(receives).toBe(MAX_RECEIVE_COUNT);
    expect(await depth(queues.deadLetter)).toBe(1);
    expect(await depth(queues.main)).toBe(0);
    expect(await transactionsOf(wallet.id)).toEqual([]);
  }, 40_000);
});

describe('WagerMessageConsumer — graceful shutdown (SIGTERM)', () => {
  it('finishes the in-flight message before stopping', async () => {
    const { queues, consumer, unitOfWork } = await harness('drain');
    const wallet = await openWallet('100.00');
    await queues.main.send(wagerMessage(wallet), { groupId: wallet.id });
    unitOfWork.delayMs = 1_500;

    consumer.start();
    await Bun.sleep(700); // received and being processed
    await consumer.stop();

    expect(await transactionsOf(wallet.id)).toEqual([{ status: 'PROCESSED', failure_code: null }]);
    expect(await depth(queues.main)).toBe(0);
  }, 30_000);

  it('returns not-yet-started messages to the queue immediately', async () => {
    // Long visibility timeout: only an explicit release can make the message visible this soon.
    const { queues, consumer, unitOfWork } = await harness('release', 10);
    const wallet = await openWallet('100.00');
    await queues.main.send(wagerMessage(wallet), { groupId: wallet.id });
    await queues.main.send(wagerMessage(wallet), { groupId: wallet.id });
    unitOfWork.delayMs = 1_500;

    consumer.start();
    await Bun.sleep(700); // first message in flight, second waiting behind it in the group
    await consumer.stop();
    const visibleRightAfterStop = await visibleCount(queues.main);

    expect(await transactionsOf(wallet.id)).toHaveLength(1);
    expect(visibleRightAfterStop).toBe(1);
  }, 30_000);
});
