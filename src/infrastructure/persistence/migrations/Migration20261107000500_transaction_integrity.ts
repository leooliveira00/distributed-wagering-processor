import { Migration } from '@mikro-orm/migrations';

/**
 * Schema-level guarantees for wager transactions (README §5.9, §6.3), the counterpart of the
 * ledger guarantees of Migration20261106000200:
 *
 * 1. A transaction is audit trail: it cannot be deleted, its identity and value never change,
 *    a terminal one (PROCESSED, REJECTED, FAILED) never changes at all, and a pending one only
 *    moves along the transitions of the domain.
 * 2. Every ledger entry belongs to a PROCESSED transaction that moves the balance (not LOSS),
 *    for the same amount and in the direction its kind implies (checked at commit time, so the
 *    entry and the transaction can be written in any order inside the transaction).
 */
export class Migration20261107000500_transaction_integrity extends Migration {
  override up(): void {
    // 1. Immutable identity and value, terminal states and domain transitions.
    this.addSql(`
      create function wager_transactions_guard_changes() returns trigger
      language plpgsql as $$
      begin
        if tg_op = 'DELETE' then
          raise exception 'wager transactions cannot be deleted (transaction %)', old.id
            using errcode = 'restrict_violation';
        end if;

        if (new.id, new.provider_id, new.external_transaction_id, new.idempotency_key,
            new.payload_hash, new.wallet_id, new.player_id, new.round_id, new.game_id, new.kind,
            new.amount, new.currency, new.reference_external_transaction_id, new.created_at)
           is distinct from
           (old.id, old.provider_id, old.external_transaction_id, old.idempotency_key,
            old.payload_hash, old.wallet_id, old.player_id, old.round_id, old.game_id, old.kind,
            old.amount, old.currency, old.reference_external_transaction_id, old.created_at) then
          raise exception 'transaction % identity and value are immutable', old.id
            using errcode = 'restrict_violation';
        end if;

        if old.status in ('PROCESSED', 'REJECTED', 'FAILED') and new is distinct from old then
          raise exception 'transaction % is % (terminal) and cannot change', old.id, old.status
            using errcode = 'restrict_violation';
        end if;

        if old.status = 'PENDING_REFERENCE'
           and new.status not in ('PENDING_REFERENCE', 'PROCESSED', 'REJECTED', 'FAILED') then
          raise exception 'transaction % cannot go from PENDING_REFERENCE to %', old.id, new.status
            using errcode = 'check_violation';
        end if;
        return new;
      end;
      $$;
    `);
    this.addSql(`
      create trigger wager_transactions_guard_changes
        before update or delete on wager_transactions
        for each row execute function wager_transactions_guard_changes();
    `);

    // 2. Ledger entry <-> transaction coherence.
    this.addSql(`
      create function wallet_ledger_entries_match_transaction() returns trigger
      language plpgsql as $$
      declare
        tx record;
        reference_kind varchar(16);
        expected varchar(6);
      begin
        select status, kind, amount, reference_transaction_id into tx
          from wager_transactions
         where id = new.transaction_id;

        if tx.status is distinct from 'PROCESSED' then
          raise exception 'ledger entry % belongs to transaction % in status %, not PROCESSED',
            new.id, new.transaction_id, tx.status
            using errcode = 'check_violation';
        end if;
        if tx.amount <> new.amount then
          raise exception 'ledger entry % amount % differs from its transaction amount %',
            new.id, new.amount, tx.amount
            using errcode = 'check_violation';
        end if;

        if tx.kind = 'BET' then
          expected := 'DEBIT';
        elsif tx.kind in ('OPENING', 'WIN', 'REFUND') then
          expected := 'CREDIT';
        elsif tx.kind = 'ROLLBACK' then
          select kind into reference_kind
            from wager_transactions
           where id = tx.reference_transaction_id;
          if reference_kind is null then
            raise exception 'ledger entry % belongs to a ROLLBACK without a resolved reference',
              new.id
              using errcode = 'check_violation';
          end if;
          -- A ROLLBACK inverts its reference: a BET debited, so it credits; WIN/REFUND credited.
          expected := case when reference_kind = 'BET' then 'CREDIT' else 'DEBIT' end;
        else
          raise exception 'ledger entry % belongs to a % transaction, which never moves the balance',
            new.id, tx.kind
            using errcode = 'check_violation';
        end if;

        if new.direction <> expected then
          raise exception 'ledger entry % is a % but a % transaction implies %',
            new.id, new.direction, tx.kind, expected
            using errcode = 'check_violation';
        end if;
        return null;
      end;
      $$;
    `);
    this.addSql(`
      create constraint trigger wallet_ledger_entries_match_transaction
        after insert on wallet_ledger_entries
        deferrable initially deferred
        for each row execute function wallet_ledger_entries_match_transaction();
    `);
  }

  override down(): void {
    this.addSql(
      `drop trigger if exists wallet_ledger_entries_match_transaction on wallet_ledger_entries;`,
    );
    this.addSql(`drop function if exists wallet_ledger_entries_match_transaction();`);
    this.addSql(`drop trigger if exists wager_transactions_guard_changes on wager_transactions;`);
    this.addSql(`drop function if exists wager_transactions_guard_changes();`);
  }
}
