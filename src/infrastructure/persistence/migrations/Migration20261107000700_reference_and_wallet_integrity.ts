import { Migration } from '@mikro-orm/migrations';

/**
 * Two more guarantees moved from the domain into the schema:
 *
 * 1. A resolved reference is coherent (rule 7.2, mirroring REFERENCE_CONTEXT_MISMATCH): the
 *    referenced transaction is the one named by `reference_external_transaction_id`, is
 *    PROCESSED, and belongs to the same provider, player, wallet, currency and round; a REFUND or
 *    ROLLBACK reverses exactly its amount (rule 7.5). Without it, raw SQL could credit wallet B by
 *    "reversing" a BET of wallet A, and mark that BET as reversed.
 * 2. A wallet is born at version 1, so its ledger is a gap-free chain from the first entry on
 *    (version 0 and below are already refused by wallets_version_positive_ck).
 */
export class Migration20261107000700_reference_and_wallet_integrity extends Migration {
  override up(): void {
    // 1. Reference coherence.
    this.addSql(`
      create function wager_transactions_reference_coherence() returns trigger
      language plpgsql as $$
      declare
        ref record;
      begin
        if new.reference_transaction_id is null then
          return new;
        end if;

        select provider_id, external_transaction_id, player_id, wallet_id, currency, round_id,
               amount, status
          into ref
          from wager_transactions
         where id = new.reference_transaction_id;

        if ref.external_transaction_id is distinct from new.reference_external_transaction_id
           or ref.provider_id <> new.provider_id
           or ref.player_id <> new.player_id
           or ref.wallet_id <> new.wallet_id
           or ref.currency <> new.currency
           or ref.round_id <> new.round_id then
          raise exception 'transaction % references % outside its provider, player, wallet, currency or round',
            new.id, new.reference_transaction_id
            using errcode = 'check_violation';
        end if;
        if ref.status <> 'PROCESSED' then
          raise exception 'transaction % references % in status %, not PROCESSED',
            new.id, new.reference_transaction_id, ref.status
            using errcode = 'check_violation';
        end if;
        if new.kind in ('REFUND', 'ROLLBACK') and ref.amount <> new.amount then
          raise exception '% % reverses % instead of the referenced amount %',
            new.kind, new.id, new.amount, ref.amount
            using errcode = 'check_violation';
        end if;
        return new;
      end;
      $$;
    `);
    this.addSql(`
      create trigger wager_transactions_reference_coherence
        before insert or update of reference_transaction_id on wager_transactions
        for each row execute function wager_transactions_reference_coherence();
    `);

    // 2. Wallets start at version 1.
    this.addSql(`
      create function wallets_initial_version() returns trigger
      language plpgsql as $$
      begin
        if new.version > 1 then
          raise exception 'wallet % must start at version 1, not %', new.id, new.version
            using errcode = 'check_violation';
        end if;
        return new;
      end;
      $$;
    `);
    this.addSql(`
      create trigger wallets_initial_version
        before insert on wallets
        for each row execute function wallets_initial_version();
    `);
  }

  override down(): void {
    this.addSql(`drop trigger if exists wallets_initial_version on wallets;`);
    this.addSql(`drop function if exists wallets_initial_version();`);
    this.addSql(
      `drop trigger if exists wager_transactions_reference_coherence on wager_transactions;`,
    );
    this.addSql(`drop function if exists wager_transactions_reference_coherence();`);
  }
}
