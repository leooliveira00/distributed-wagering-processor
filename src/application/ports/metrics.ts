/**
 * Metrics port. Names are a closed union so a typo is a compile error, not a silent new series.
 * New metrics are added here together with their help text in the adapter.
 *
 * Labels must have LOW cardinality: never a wallet, player or transaction id (they would create
 * one series per id and expose player data). Those ids belong in the logs.
 */
export type CounterName =
  | 'wager_transactions_total'
  | 'wager_idempotent_replays_total'
  | 'wager_idempotency_conflicts_total'
  | 'db_lock_conflicts_total'
  | 'wallet_reconciliations_total'
  | 'wallet_reconciliation_divergences_total'
  | 'outbox_events_published_total'
  | 'outbox_publish_failures_total'
  | 'sqs_messages_received_total'
  | 'sqs_messages_processed_total'
  | 'sqs_duplicate_messages_total'
  | 'sqs_message_retries_total'
  | 'sqs_messages_dead_lettered_total'
  | 'pending_reference_attempts_total'
  | 'pending_reference_failures_total';

export type HistogramName =
  | 'wager_processing_duration_seconds'
  | 'wallet_lock_wait_seconds'
  | 'http_request_duration_seconds'
  | 'outbox_publish_delay_seconds';

export type MetricLabels = Readonly<Record<string, string>>;

export interface Metrics {
  increment(name: CounterName, labels?: MetricLabels, value?: number): void;
  /** Records one observation, in seconds for every `*_seconds` histogram. */
  observe(name: HistogramName, value: number, labels?: MetricLabels): void;
}

export const METRICS = Symbol('METRICS');
