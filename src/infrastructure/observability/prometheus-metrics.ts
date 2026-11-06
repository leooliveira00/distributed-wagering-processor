import { collectDefaultMetrics, Counter, Histogram, Registry } from 'prom-client';
import {
  type CounterName,
  type HistogramName,
  type MetricLabels,
  type Metrics,
} from '../../application/ports/metrics';

const COUNTERS: Readonly<Record<CounterName, { help: string; labels: readonly string[] }>> = {
  wager_transactions_total: {
    help: 'Wager transaction outcomes persisted, by kind, status and source (submission or pending-worker)',
    labels: ['kind', 'status', 'source'],
  },
  wager_idempotent_replays_total: {
    help: 'Submissions answered as an idempotent replay of an earlier one, by entry point',
    labels: ['entrypoint'],
  },
  wager_idempotency_conflicts_total: {
    help: 'Submissions refused because the key or message was reused with a different payload',
    labels: ['entrypoint', 'code'],
  },
  db_lock_conflicts_total: {
    help: 'Transactions aborted by a concurrency conflict (lock timeout, deadlock, serialization, version)',
    labels: ['reason'],
  },
  wallet_reconciliations_total: {
    help: 'Wallet reconciliations executed, by result',
    labels: ['result'],
  },
  wallet_reconciliation_divergences_total: {
    help: 'Reconciliations where the stored balance differs from the ledger',
    labels: [],
  },
  outbox_events_published_total: {
    help: 'Integration events published from the outbox',
    labels: [],
  },
  outbox_publish_failures_total: {
    help: 'Failed outbox publication attempts (retried with backoff)',
    labels: ['eventType'],
  },
  sqs_messages_received_total: {
    help: 'Messages received from the wager transactions queue',
    labels: [],
  },
  sqs_messages_processed_total: {
    help: 'Messages acknowledged, by outcome',
    labels: ['outcome'],
  },
  sqs_duplicate_messages_total: {
    help: 'Redelivered or duplicate messages detected by the inbox or idempotency key',
    labels: [],
  },
  sqs_message_retries_total: {
    help: 'Messages left for a backoff retry, by reason',
    labels: ['reason'],
  },
  sqs_messages_dead_lettered_total: {
    help: 'Messages moved to the dead-letter queue by the consumer, by reason',
    labels: ['reason'],
  },
  pending_reference_attempts_total: {
    help: 'Worker attempts on PENDING_REFERENCE transactions, by outcome (processed, rejected, rescheduled)',
    labels: ['outcome'],
  },
  pending_reference_failures_total: {
    help: 'Worker attempts that failed unexpectedly and were deferred with backoff',
    labels: [],
  },
};

/** Latency buckets (seconds): sub-millisecond to 10s, the range a single operation lives in. */
const LATENCY_BUCKETS = [0.001, 0.0025, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];

const HISTOGRAMS: Readonly<
  Record<HistogramName, { help: string; labels: readonly string[]; buckets: readonly number[] }>
> = {
  wager_processing_duration_seconds: {
    help: 'Time to process a wager submission, from arrival to commit, by entry point and outcome',
    labels: ['entrypoint', 'outcome'],
    buckets: LATENCY_BUCKETS,
  },
  wallet_lock_wait_seconds: {
    help: 'Time waiting for the wallet row lock (SELECT ... FOR UPDATE): contention on hot wallets',
    labels: ['source'],
    buckets: LATENCY_BUCKETS,
  },
  http_request_duration_seconds: {
    help: 'HTTP request duration by method, route template and status code',
    labels: ['method', 'route', 'status'],
    buckets: LATENCY_BUCKETS,
  },
  outbox_publish_delay_seconds: {
    help: 'Delay between an event being committed and published to the broker (outbox lag)',
    labels: [],
    buckets: [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 120, 300],
  },
};

/** prom-client adapter with its own registry (no global state shared between tests). */
export class PrometheusMetrics implements Metrics {
  readonly registry = new Registry();
  private readonly counters = new Map<CounterName, Counter>();
  private readonly histograms = new Map<HistogramName, Histogram>();

  constructor() {
    // Process metrics (CPU, memory, event loop lag, GC) for the same registry.
    collectDefaultMetrics({ register: this.registry });
    for (const [name, definition] of Object.entries(HISTOGRAMS) as [
      HistogramName,
      (typeof HISTOGRAMS)[HistogramName],
    ][]) {
      this.histograms.set(
        name,
        new Histogram({
          name,
          help: definition.help,
          labelNames: [...definition.labels],
          buckets: [...definition.buckets],
          registers: [this.registry],
        }),
      );
    }
    for (const [name, definition] of Object.entries(COUNTERS) as [
      CounterName,
      (typeof COUNTERS)[CounterName],
    ][]) {
      this.counters.set(
        name,
        new Counter({
          name,
          help: definition.help,
          labelNames: [...definition.labels],
          registers: [this.registry],
        }),
      );
    }
  }

  increment(name: CounterName, labels: MetricLabels = {}, value = 1): void {
    this.counters.get(name)?.inc({ ...labels }, value);
  }

  observe(name: HistogramName, value: number, labels: MetricLabels = {}): void {
    this.histograms.get(name)?.observe({ ...labels }, value);
  }

  /** Number of observations recorded for the given labels (tests and diagnostics). */
  async observationCount(name: HistogramName, labels: MetricLabels = {}): Promise<number> {
    const metric = await this.histograms.get(name)?.get();
    const match = metric?.values.find(
      (sample) =>
        sample.metricName === `${name}_count` &&
        Object.entries(labels).every(([key, label]) => sample.labels[key] === label),
    );
    return match?.value ?? 0;
  }

  async counterValue(name: CounterName, labels: MetricLabels = {}): Promise<number> {
    const metric = await this.counters.get(name)?.get();
    const match = metric?.values.find((sample) =>
      Object.entries(labels).every(([key, label]) => sample.labels[key] === label),
    );
    return match?.value ?? 0;
  }
}
