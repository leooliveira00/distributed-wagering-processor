/**
 * Load test (README §14, "diferencial"): `bun run test:load` against a running cluster.
 *
 *   docker compose --profile cluster up -d --build --wait
 *   bun run test:load
 *
 * Four scenarios, each a closed loop of concurrent clients spread round-robin over the
 * instances: many wallets (low contention), one hot wallet (lock contention), resends of used
 * keys (idempotent replays) and a queue backlog drained by the consumers. Client-side latency
 * percentiles are exact; server-side figures come from the difference of /metrics before and
 * after each scenario. At the end every wallet used must reconcile: speed without correctness
 * would prove nothing. Methodology and results: docs/LOAD_TEST.md.
 */
import {
  GetQueueAttributesCommand,
  GetQueueUrlCommand,
  SendMessageBatchCommand,
} from '@aws-sdk/client-sqs';
import os from 'node:os';
import { type WalletView } from '../../src/application/wallets/wallet-views';
import { createSqsClient } from '../../src/infrastructure/messaging/sqs/sqs-client';
import { loadEnv } from '../../src/infrastructure/config/env';
import {
  delta,
  deltaBy,
  histogramMeanMs,
  histogramQuantileMs,
  type Scrape,
  scrape,
  total,
} from './cluster-metrics';
import { classify, round, type Sample, summarize } from './stats';

const urls = (
  process.env.LOAD_API_URLS ?? 'http://localhost:3000,http://localhost:3001,http://localhost:3002'
)
  .split(',')
  .map((url) => url.trim())
  .filter((url) => url.length > 0);
const DURATION_MS = Number(process.env.LOAD_DURATION_S ?? '30') * 1000;
const WARMUP_MS = Number(process.env.LOAD_WARMUP_S ?? '5') * 1000;
const CONCURRENCY = Number(process.env.LOAD_CONCURRENCY ?? '32');
const QUEUE_MESSAGES = Number(process.env.LOAD_QUEUE_MESSAGES ?? '2000');
const PROVIDER = 'provider-load';
const RICH = '1000000.00'; // never runs out: every BET is affordable, rejections stay at zero

interface Operation {
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: 'BET' | 'WIN';
  money: { amount: string; currency: string };
}

const keyOf = (op: Operation) => `${op.providerId}:${op.externalTransactionId}`;
let sequence = 0;

function newOperation(wallet: WalletView): Operation {
  return {
    providerId: PROVIDER,
    externalTransactionId: `load-${String(Date.now())}-${String(sequence++)}`,
    playerId: wallet.playerId,
    walletId: wallet.id,
    roundId: 'round-load',
    gameId: 'fortune-chimp',
    kind: Math.random() < 0.8 ? 'BET' : 'WIN',
    money: { amount: '1.00', currency: 'BRL' },
  };
}

let cursor = 0;
const nextUrl = () => urls[cursor++ % urls.length] ?? 'http://localhost:3000';

async function post(path: string, body: unknown, headers: Record<string, string> = {}) {
  return fetch(`${nextUrl()}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
}

async function openWallets(count: number): Promise<WalletView[]> {
  const wallets: WalletView[] = [];
  for (let start = 0; start < count; start += 16) {
    const batch = await Promise.all(
      Array.from({ length: Math.min(16, count - start) }, async () => {
        const response = await post('/wallets', {
          playerId: crypto.randomUUID(),
          initialBalance: { amount: RICH, currency: 'BRL' },
        });
        if (response.status !== 201) throw new Error(`wallet creation: ${String(response.status)}`);
        return (await response.json()) as WalletView;
      }),
    );
    wallets.push(...batch);
  }
  return wallets;
}

/** Samples the outbox lag gauge once a second while `running()` holds; returns the peaks. */
async function sampleOutboxLag(running: () => boolean) {
  let maxAgeSeconds = 0;
  let maxPending = 0;
  while (running()) {
    try {
      const snapshot = await scrape(urls.slice(0, 1));
      maxAgeSeconds = Math.max(maxAgeSeconds, total(snapshot, 'outbox_oldest_pending_age_seconds'));
      maxPending = Math.max(maxPending, total(snapshot, 'outbox_pending_events'));
    } catch {
      // a slow scrape under load is not a reason to stop the test
    }
    await Bun.sleep(1000);
  }
  return { maxAgeSeconds, maxPending };
}

/**
 * Samples `docker stats` (CPU % of ONE core, per container) every few seconds while `running()`
 * holds. Optional: without the docker CLI the report simply has no CPU section.
 */
async function sampleContainerCpu(running: () => boolean) {
  const samples = new Map<string, number[]>();
  while (running()) {
    try {
      const child = Bun.spawn(
        ['docker', 'stats', '--no-stream', '--format', '{{.Name}} {{.CPUPerc}}'],
        { stdout: 'pipe', stderr: 'ignore' },
      );
      for (const line of (await new Response(child.stdout).text()).split('\n')) {
        const [name, cpu] = line.trim().split(/\s+/);
        if (!name?.startsWith('wagering-') || cpu === undefined) continue;
        const value = Number.parseFloat(cpu);
        if (Number.isFinite(value)) samples.set(name, [...(samples.get(name) ?? []), value]);
      }
    } catch {
      return samples; // no docker CLI on this machine
    }
    await Bun.sleep(3000);
  }
  return samples;
}

function reportCpu(samples: Map<string, number[]>) {
  if (samples.size === 0) return;
  const parts = [...samples.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, values]) => {
      const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
      return `${name.replace('wagering-', '')} ${String(round(mean, 0))}/${String(round(Math.max(...values), 0))}`;
    });
  console.log(`  container CPU, % of one core (mean/max): ${parts.join('  ')}`);
}

/**
 * Waits until every committed event is published, with no HTTP load: the publishers' drain rate
 * on their own, and a clean start for the next scenario (no inherited backlog).
 */
async function drainOutbox() {
  const pendingNow = async () => total(await scrape(urls.slice(0, 1)), 'outbox_pending_events');
  const pending = await pendingNow();
  if (pending === 0) return;
  const before = await scrape(urls);
  const started = performance.now();
  const deadline = Date.now() + 15 * 60_000;
  while ((await pendingNow()) > 0 && Date.now() < deadline) await Bun.sleep(1000);
  const seconds = (performance.now() - started) / 1000;
  const published = delta(before, await scrape(urls), 'outbox_events_published_total');
  console.log(
    `  outbox drain after the load: ${String(published)} events in ${String(round(seconds))}s → ${String(round(published / seconds))} events/s`,
  );
}

interface HttpScenario {
  name: string;
  /** What each request sends; `replay` marks a resend of a key already used. */
  next: () => { op: Operation; replay: boolean };
  onSuccess?: (op: Operation) => void;
}

interface HttpResult {
  name: string;
  samples: Sample[];
  seconds: number;
  before: Scrape;
  after: Scrape;
  outbox: { maxAgeSeconds: number; maxPending: number };
  cpu: Map<string, number[]>;
}

async function runHttp(scenario: HttpScenario): Promise<HttpResult> {
  console.log(
    `\n▶ ${scenario.name}: ${String(CONCURRENCY)} clients, ${String(WARMUP_MS / 1000)}s warm-up + ${String(DURATION_MS / 1000)}s`,
  );
  const samples: Sample[] = [];
  const warmupEnds = Date.now() + WARMUP_MS;
  const ends = warmupEnds + DURATION_MS;
  let measuring = false;

  const send = async (op: Operation): Promise<number> => {
    try {
      const response = await post('/wagering/transactions', op, { 'idempotency-key': keyOf(op) });
      await response.arrayBuffer();
      return response.status;
    } catch {
      return 0; // the connection itself failed
    }
  };

  const client = async () => {
    while (Date.now() < ends) {
      const { op, replay } = scenario.next();
      const started = performance.now();
      const status = await send(op);
      const latencyMs = performance.now() - started;
      if (status === 201) scenario.onSuccess?.(op);
      if (measuring && Date.now() < ends) samples.push({ latencyMs, status, replay });
    }
  };

  const clients = Array.from({ length: CONCURRENCY }, client);
  await Bun.sleep(WARMUP_MS);
  const before: Scrape = await scrape(urls);
  measuring = true;
  const measuredFrom = performance.now();
  const lag = sampleOutboxLag(() => Date.now() < ends);
  const cpuSamples = sampleContainerCpu(() => Date.now() < ends);
  await Promise.all(clients);
  const seconds = (performance.now() - measuredFrom) / 1000;
  const outbox = await lag;
  const cpu = await cpuSamples;
  const after = await scrape(urls);
  return { name: scenario.name, samples, seconds, before, after, outbox, cpu };
}

function report(result: HttpResult) {
  const { samples, seconds, before, after } = result;
  const byClass = { business: 0, transient: 0, error: 0 };
  for (const sample of samples) byClass[classify(sample.status)]++;
  const fresh = summarize(
    samples.filter((s) => !s.replay && classify(s.status) === 'business').map((s) => s.latencyMs),
  );
  const replays = summarize(
    samples.filter((s) => s.replay && classify(s.status) === 'business').map((s) => s.latencyMs),
  );
  const statuses: Record<string, number> = {};
  for (const sample of samples)
    statuses[String(sample.status)] = (statuses[String(sample.status)] ?? 0) + 1;

  console.log(
    `  requests: ${String(samples.length)} in ${String(round(seconds))}s → ${String(round(samples.length / seconds))} req/s`,
  );
  console.log(`  status: ${JSON.stringify(statuses)}`);
  console.log(
    `  503 (transient): ${String(round((byClass.transient / samples.length) * 100, 2))}%  ` +
      `errors: ${String(round((byClass.error / samples.length) * 100, 2))}%`,
  );
  console.log(
    `  latency (new ops, ms): p50 ${String(round(fresh.p50))}  p95 ${String(round(fresh.p95))}  p99 ${String(round(fresh.p99))}  max ${String(round(fresh.max))}`,
  );
  if (replays.count > 0) {
    console.log(
      `  latency (replays, ms): p50 ${String(round(replays.p50))}  p95 ${String(round(replays.p95))}  p99 ${String(round(replays.p99))}  (${String(replays.count)} replays)`,
    );
  }
  console.log(
    `  lock conflicts: ${JSON.stringify(deltaBy(before, after, 'db_lock_conflicts_total', 'reason'))}`,
  );
  console.log(
    `  wallet lock wait (server, ms): mean ${String(round(histogramMeanMs(before, after, 'wallet_lock_wait_seconds'), 2))}  p95 ≤ ${String(histogramQuantileMs(before, after, 'wallet_lock_wait_seconds', 0.95))}`,
  );
  console.log(
    `  idempotent replays (server): ${String(delta(before, after, 'wager_idempotent_replays_total'))}`,
  );
  console.log(
    `  outbox publish delay (server, ms): mean ${String(round(histogramMeanMs(before, after, 'outbox_publish_delay_seconds')))}  p95 ≤ ${String(histogramQuantileMs(before, after, 'outbox_publish_delay_seconds', 0.95))}`,
  );
  console.log(
    `  outbox lag (peak): oldest pending ${String(round(result.outbox.maxAgeSeconds, 2))}s, ${String(result.outbox.maxPending)} pending events`,
  );
  reportCpu(result.cpu);
}

async function runQueue(wallets: WalletView[]) {
  console.log(
    `\n▶ Queue backlog: ${String(QUEUE_MESSAGES)} messages over ${String(wallets.length)} wallets`,
  );
  const env = loadEnv();
  const sqs = createSqsClient({
    ...env,
    AWS_ENDPOINT_URL: env.AWS_ENDPOINT_URL ?? 'http://localhost:4566',
  });
  const { QueueUrl } = await sqs.send(
    new GetQueueUrlCommand({ QueueName: env.SQS_WAGER_QUEUE_NAME }),
  );
  const before = await scrape(urls);
  const started = performance.now();

  const entries = Array.from({ length: QUEUE_MESSAGES }, (_, index) => {
    const wallet = wallets[index % wallets.length];
    if (!wallet) throw new Error('no wallet');
    const op = newOperation(wallet);
    return {
      Id: String(index),
      MessageGroupId: wallet.id,
      MessageDeduplicationId: op.externalTransactionId,
      MessageBody: JSON.stringify({
        messageId: `msg-${op.externalTransactionId}`,
        type: 'WagerTransactionRequested',
        occurredAt: new Date().toISOString(),
        data: { ...op, idempotencyKey: keyOf(op) },
      }),
    };
  });
  for (let start = 0; start < entries.length; start += 100) {
    await Promise.all(
      Array.from({ length: 10 }, (_, slice) =>
        entries.slice(start + slice * 10, start + slice * 10 + 10),
      )
        .filter((batch) => batch.length > 0)
        .map((Entries) => sqs.send(new SendMessageBatchCommand({ QueueUrl, Entries }))),
    );
  }
  const enqueuedSeconds = (performance.now() - started) / 1000;

  let processed = 0;
  const deadline = Date.now() + 10 * 60_000;
  while (Date.now() < deadline) {
    processed = delta(before, await scrape(urls), 'sqs_messages_processed_total');
    if (processed >= QUEUE_MESSAGES) break;
    await Bun.sleep(250);
  }
  const seconds = (performance.now() - started) / 1000;
  const after = await scrape(urls);
  const { Attributes = {} } = await sqs.send(
    new GetQueueAttributesCommand({ QueueUrl, AttributeNames: ['ApproximateNumberOfMessages'] }),
  );
  sqs.destroy();

  console.log(
    `  enqueued in ${String(round(enqueuedSeconds))}s; ${String(processed)} processed in ${String(round(seconds))}s → ${String(round(processed / seconds))} msg/s`,
  );
  console.log(
    `  outcomes: ${JSON.stringify(deltaBy(before, after, 'sqs_messages_processed_total', 'outcome'))}`,
  );
  console.log(
    `  retries: ${String(delta(before, after, 'sqs_message_retries_total'))}  dead-lettered: ${String(delta(before, after, 'sqs_messages_dead_lettered_total'))}  left in queue: ${Attributes.ApproximateNumberOfMessages ?? '?'}`,
  );
  console.log(
    `  lock conflicts: ${JSON.stringify(deltaBy(before, after, 'db_lock_conflicts_total', 'reason'))}`,
  );
  console.log(
    `  processing (server, ms): mean ${String(round(histogramMeanMs(before, after, 'wager_processing_duration_seconds'), 2))}`,
  );
}

async function reconcileAll(wallets: WalletView[]) {
  let inconsistent = 0;
  for (let start = 0; start < wallets.length; start += 16) {
    const results = await Promise.all(
      wallets.slice(start, start + 16).map(async (wallet) => {
        const response = await post(`/wallets/${wallet.id}/reconciliation`, {});
        return ((await response.json()) as { consistent: boolean }).consistent;
      }),
    );
    inconsistent += results.filter((consistent) => !consistent).length;
  }
  console.log(
    `\n✔ Reconciliation of ${String(wallets.length)} wallets: ${String(inconsistent)} inconsistent`,
  );
  return inconsistent;
}

// ---------------------------------------------------------------------------------------------

console.log('Environment');
console.log(
  `  host: ${os.cpus()[0]?.model ?? 'unknown CPU'}, ${String(os.cpus().length)} logical CPUs, ${String(round(os.totalmem() / 1024 ** 3))} GB, ${os.platform()} ${os.release()}`,
);
console.log(`  bun ${Bun.version}; instances: ${urls.join(', ')}`);
console.log(`  load generator, instances, PostgreSQL and the SQS emulator share this machine`);

const distributed = await openWallets(200);
const [hot] = await openWallets(1);
const queueWallets = await openWallets(100);
if (!hot) throw new Error('no hot wallet');
const pick = () => distributed[Math.floor(Math.random() * distributed.length)] ?? hot;

// Every scenario starts with an empty outbox, so none inherits the backlog of the previous one.
await drainOutbox();
report(
  await runHttp({
    name: 'Distributed: 200 wallets',
    next: () => ({ op: newOperation(pick()), replay: false }),
  }),
);
await drainOutbox();
report(
  await runHttp({
    name: 'Hot wallet: 1 wallet',
    next: () => ({ op: newOperation(hot), replay: false }),
  }),
);
await drainOutbox();

const used: Operation[] = [];
report(
  await runHttp({
    name: 'Resends: 200 wallets, 20% replays',
    next: () => {
      const previous = used[Math.floor(Math.random() * used.length)];
      if (previous && Math.random() < 0.2) return { op: previous, replay: true };
      return { op: newOperation(pick()), replay: false };
    },
    onSuccess: (op) => {
      if (used.length < 5000) used.push(op);
    },
  }),
);
await drainOutbox();

await runQueue(queueWallets);
await drainOutbox();
const inconsistent = await reconcileAll([...distributed, hot, ...queueWallets]);
process.exit(inconsistent === 0 ? 0 : 1);
