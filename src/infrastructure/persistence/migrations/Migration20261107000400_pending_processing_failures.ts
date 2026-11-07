import { Migration } from '@mikro-orm/migrations';

/**
 * Counts the attempts of a PENDING_REFERENCE transaction that failed for a reason other than a
 * temporary infrastructure failure (a bug, invalid data). Kept apart from `attempts`, which
 * counts the searches for the reference: a run of lock timeouts must never turn into a false
 * REFERENCE_NOT_FOUND, and an outage must never push valid transactions to FAILED. Past the
 * limit, the worker marks the transaction FAILED / PROCESSING_FAILED.
 */
export class Migration20261107000400_pending_processing_failures extends Migration {
  override up(): void {
    this.addSql(`
      alter table wager_transactions
        add column processing_failures integer not null default 0,
        add constraint wager_transactions_processing_failures_ck check (processing_failures >= 0);
    `);
  }

  override down(): void {
    this.addSql(`
      alter table wager_transactions
        drop constraint if exists wager_transactions_processing_failures_ck,
        drop column if exists processing_failures;
    `);
  }
}
