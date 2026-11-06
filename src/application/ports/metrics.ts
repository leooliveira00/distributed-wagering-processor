/**
 * Metrics port. Names are a closed union so a typo is a compile error, not a silent new series.
 * New metrics are added here together with their help text in the adapter.
 */
export type CounterName =
  'wallet_reconciliations_total' | 'wallet_reconciliation_divergences_total';

export type MetricLabels = Readonly<Record<string, string>>;

export interface Metrics {
  increment(name: CounterName, labels?: MetricLabels, value?: number): void;
}

export const METRICS = Symbol('METRICS');
