import { Migration } from '@mikro-orm/migrations';

/**
 * Finds the PENDING_REFERENCE transactions waiting for a given provider transaction, so they are
 * re-evaluated as soon as it reaches a terminal state (expediteDependents) instead of after the
 * backoff. Partial: only pending rows, which are few at any time, are indexed.
 */
export class Migration20261106000300_pending_dependents_index extends Migration {
  override up(): void {
    this.addSql(`
      create index wager_transactions_pending_dependents_idx
        on wager_transactions (provider_id, reference_external_transaction_id)
        where status = 'PENDING_REFERENCE';
    `);
  }

  override down(): void {
    this.addSql(`drop index if exists wager_transactions_pending_dependents_idx;`);
  }
}
