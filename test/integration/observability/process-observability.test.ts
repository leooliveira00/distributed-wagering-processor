import { GetQueueAttributesCommand } from '@aws-sdk/client-sqs';
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { type WalletView } from '../../../src/application/wallets/wallet-views';
import { type Instance, spawnInstance, waitUntilLive } from '../../concurrency/support/instances';
import { sampleValue } from '../support/prometheus-text';
import { createTestDatabase, type TestDatabase } from '../support/test-database';
import { createQueuePair, type QueuePair } from '../support/test-queue';

/**
 * README §12 end to end, on a real process (`bun src/main.ts`, roles api + consumer): what the
 * JSON on stdout really contains, what /metrics really exposes, and what readiness answers.
 * Test doubles cannot catch duplicated keys or a leaked amount in the real pino output.
 */
let db: TestDatabase;
let queues: QueuePair;
let instance: Instance;
let wallet: WalletView;
const CONTEXT_KEYS = ['correlationId', 'messageId', 'transactionId', 'walletId', 'providerId'];

beforeAll(async () => {
  db = await createTestDatabase('process_observability');
  queues = await createQueuePair(db.env, 'process-observability', {
    visibilityTimeoutSeconds: 30,
    maxReceiveCount: 5,
  });
  instance = spawnInstance(
    db.env,
    {
      APP_ROLES: 'api,consumer',
      LOG_LEVEL: 'info',
      SQS_WAGER_QUEUE_NAME: queues.main.name,
      SQS_WAGER_DLQ_NAME: queues.deadLetter.name,
      SQS_CONSUMER_WAIT_TIME_SECONDS: '1',
    },
    { captureStdout: true },
  );
  await waitUntilLive(instance.url, instance.process);
  await generateTraffic();
}, 90_000);

afterAll(async () => {
  instance.process.kill();
  await instance.process.exited;
  await queues.close();
  await db.close();
});

const post = (path: string, body: unknown, headers: Record<string, string>) =>
  fetch(`${instance.url}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });

function operation(externalTransactionId: string, amount: string) {
  return {
    providerId: 'provider-a',
    externalTransactionId,
    playerId: wallet.playerId,
    walletId: wallet.id,
    roundId: 'round-1',
    gameId: 'fortune-chimp',
    kind: 'BET',
    money: { amount, currency: 'BRL' },
  };
}

const message = (messageId: string, data: ReturnType<typeof operation>) => ({
  messageId,
  type: 'WagerTransactionRequested',
  occurredAt: new Date().toISOString(),
  data: { ...data, idempotencyKey: `provider-a:${data.externalTransactionId}` },
});

async function queueDepth(): Promise<number> {
  const { Attributes = {} } = await queues.main.sqs.send(
    new GetQueueAttributesCommand({
      QueueUrl: queues.main.url,
      AttributeNames: ['ApproximateNumberOfMessages', 'ApproximateNumberOfMessagesNotVisible'],
    }),
  );
  return (
    Number(Attributes.ApproximateNumberOfMessages ?? '0') +
    Number(Attributes.ApproximateNumberOfMessagesNotVisible ?? '0')
  );
}

/** HTTP: a wallet and a BET. SQS: a BET, then a conflicting reuse of its idempotency key. */
async function generateTraffic(): Promise<void> {
  wallet = (await (
    await post(
      '/wallets',
      { playerId: crypto.randomUUID(), initialBalance: { amount: '100.00', currency: 'BRL' } },
      { 'x-correlation-id': 'corr-obs-wallet' },
    )
  ).json()) as WalletView;
  const response = await post('/wagering/transactions', operation('tx-http-1', '25.00'), {
    'idempotency-key': 'provider-a:tx-http-1',
    'x-correlation-id': 'corr-obs-bet',
  });
  expect(response.status).toBe(201);
  expect(response.headers.get('x-correlation-id')).toBe('corr-obs-bet');

  const queued = operation('tx-sqs-1', '25.00');
  await queues.main.send(message('msg-obs-1', queued), { groupId: wallet.id });
  await queues.main.send(
    message('msg-obs-2', { ...queued, money: { amount: '9.00', currency: 'BRL' } }),
    {
      groupId: wallet.id,
    },
  );
  const deadline = Date.now() + 30_000;
  while ((await queueDepth()) > 0) {
    if (Date.now() > deadline) throw new Error('queue was not drained in time');
    await Bun.sleep(200);
  }
  await Bun.sleep(300); // let the last lines reach stdout
}

const parsed = () =>
  instance.stdoutLines().map((line) => JSON.parse(line) as Record<string, unknown>);

describe('logs written by a real process', () => {
  it('are JSON lines from the service', () => {
    const lines = parsed();
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) expect(line.service).toBe('distributed-wagering-processor');
  });

  it('carry the request scope on the HTTP request line, each key exactly once', () => {
    const raw = instance
      .stdoutLines()
      .find(
        (line) =>
          line.includes('"url":"/wagering/transactions"') && line.includes('request completed'),
      );
    expect(raw).toBeDefined();
    const line = JSON.parse(raw ?? '{}') as Record<string, unknown>;
    expect(line).toMatchObject({
      correlationId: 'corr-obs-bet',
      walletId: wallet.id,
      providerId: 'provider-a',
    });
    expect(line.transactionId).toBeString();
    for (const key of ['correlationId', 'walletId', 'providerId', 'transactionId']) {
      expect(raw?.match(new RegExp(`"${key}":`, 'g'))).toHaveLength(1);
    }
  });

  it('carry the message scope on lines written while handling a queue message', () => {
    const conflict = parsed().find(
      (line) => line.msg === 'Message conflicts with an existing transaction, acknowledged',
    );
    expect(conflict).toMatchObject({
      messageId: 'msg-obs-2',
      correlationId: 'msg-obs-2',
      walletId: wallet.id,
      providerId: 'provider-a',
    });
  });

  it('never repeat a context key on any line', () => {
    for (const raw of instance.stdoutLines()) {
      for (const key of CONTEXT_KEYS) {
        expect(raw.match(new RegExp(`"${key}":`, 'g'))?.length ?? 0).toBeLessThanOrEqual(1);
      }
    }
  });

  it('never contain money values', () => {
    for (const raw of instance.stdoutLines()) {
      expect(raw).not.toMatch(/\b(25|9|100|75|50)\.00\b/);
      expect(raw).not.toMatch(/"(amount|balance|initialBalance)":"\d/);
    }
  });
});

describe('/metrics and readiness of a real process', () => {
  it('expose the README §12 series for the traffic above, without ids', async () => {
    const text = await (await fetch(`${instance.url}/metrics`)).text();

    expect(
      sampleValue(text, 'wager_transactions_total', {
        kind: 'BET',
        status: 'PROCESSED',
        source: 'submission',
      }),
    ).toBe(2);
    expect(
      sampleValue(text, 'wager_idempotency_conflicts_total', {
        entrypoint: 'sqs',
        code: 'IDEMPOTENCY_KEY_CONFLICT',
      }),
    ).toBe(1);
    expect(sampleValue(text, 'sqs_queue_messages', { queue: 'dead_letter' })).toBe(0); // consumer role
    expect(text).not.toContain('outbox_pending_events'); // no outbox role here
    expect(text).not.toContain(wallet.id);
  });

  it('report ready while PostgreSQL and the queue are reachable', async () => {
    const response = await fetch(`${instance.url}/health/ready`);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: 'ok' });
  });
});
