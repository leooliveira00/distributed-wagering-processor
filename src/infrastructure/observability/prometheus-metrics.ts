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
