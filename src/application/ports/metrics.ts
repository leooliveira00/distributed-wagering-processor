/**
 * Metrics port. Names are a closed union so a typo is a compile error, not a silent new series.
 * New metrics are added here together with their help text in the adapter.
 */
export type CounterName =
  | 'wallet_reconciliations_total'
  | 'wallet_reconciliation_divergences_total'
  | 'outbox_events_published_total'
  | 'outbox_publish_failures_total'
  | 'sqs_messages_received_total'
  | 'sqs_messages_processed_total'
  | 'sqs_duplicate_messages_total'
  | 'sqs_message_retries_total'
  | 'sqs_messages_dead_lettered_total';

export type MetricLabels = Readonly<Record<string, string>>;

export interface Metrics {
  increment(name: CounterName, labels?: MetricLabels, value?: number): void;
}

export const METRICS = Symbol('METRICS');
