import { Migration } from '@mikro-orm/migrations';

/**
 * The other direction of the ledger <-> transaction coherence (README §6.2: every balance change
 * has a ledger entry and vice versa): a PROCESSED transaction that moves the balance (every kind
 * but LOSS) must have its ledger entry. Checked at commit time, so the transaction and the entry
 * can be written in any order inside the SQL transaction.
 */
export class Migration20261107000600_processed_has_entry extends Migration {
  override up(): void {
    this.addSql(`
      create function wager_transactions_processed_has_entry() returns trigger
      language plpgsql as $$
      begin
        if new.status = 'PROCESSED' and new.kind <> 'LOSS' and not exists (
          select 1 from wallet_ledger_entries e where e.transaction_id = new.id
        ) then
          raise exception 'PROCESSED % transaction % has no ledger entry', new.kind, new.id
            using errcode = 'check_violation';
        end if;
        return null;
      end;
      $$;
    `);
    this.addSql(`
      create constraint trigger wager_transactions_processed_has_entry
        after insert or update of status on wager_transactions
        deferrable initially deferred
        for each row execute function wager_transactions_processed_has_entry();
    `);
  }

  override down(): void {
    this.addSql(
      `drop trigger if exists wager_transactions_processed_has_entry on wager_transactions;`,
    );
    this.addSql(`drop function if exists wager_transactions_processed_has_entry();`);
  }
}
