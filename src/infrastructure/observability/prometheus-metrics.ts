import { Counter, Registry } from 'prom-client';
import { type CounterName, type MetricLabels, type Metrics } from '../../application/ports/metrics';

const COUNTERS: Readonly<Record<CounterName, { help: string; labels: readonly string[] }>> = {
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

/** prom-client adapter with its own registry (no global state shared between tests). */
export class PrometheusMetrics implements Metrics {
  readonly registry = new Registry();
  private readonly counters = new Map<CounterName, Counter>();

  constructor() {
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

  async counterValue(name: CounterName, labels: MetricLabels = {}): Promise<number> {
    const metric = await this.counters.get(name)?.get();
    const match = metric?.values.find((sample) =>
      Object.entries(labels).every(([key, label]) => sample.labels[key] === label),
    );
    return match?.value ?? 0;
  }
}
