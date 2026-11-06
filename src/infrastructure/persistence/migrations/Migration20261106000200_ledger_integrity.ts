import { Migration } from '@mikro-orm/migrations';

/**
 * Database-level guarantees for the ledger and the balance/ledger consistency:
 *
 * 1. The ledger is append-only: UPDATE, DELETE and TRUNCATE are rejected.
 * 2. Wallet identity is immutable, wallets cannot be deleted, and `version` moves by exactly
 *    one when (and only when) the balance changes.
 * 3. Every balance change, including a positive opening balance, has the matching ledger entry
 *    for that wallet version (checked at commit time).
 * 4. Every ledger entry corresponds to an existing wallet version, and the latest entry matches
 *    the current balance (checked at commit time).
 *
 * Checks 3 and 4 are DEFERRABLE INITIALLY DEFERRED constraint triggers, so the wallet update and
 * the ledger insert can happen in any order inside the transaction; they run on COMMIT.
 */
export class Migration20261106000200_ledger_integrity extends Migration {
  override up(): void {
    // 1. Append-only ledger.
    this.addSql(`
      create function wallet_ledger_entries_append_only() returns trigger
      language plpgsql as $$
      begin
        raise exception 'wallet_ledger_entries is append-only: % is not allowed', tg_op
          using errcode = 'restrict_violation';
      end;
      $$;
    `);
    this.addSql(`
      create trigger wallet_ledger_entries_no_update_delete
        before update or delete on wallet_ledger_entries
        for each row execute function wallet_ledger_entries_append_only();
    `);
    this.addSql(`
      create trigger wallet_ledger_entries_no_truncate
        before truncate on wallet_ledger_entries
        for each statement execute function wallet_ledger_entries_append_only();
    `);

    // 2. Wallet identity, deletion and version discipline.
    this.addSql(`
      create function wallets_guard_changes() returns trigger
      language plpgsql as $$
      begin
        if tg_op = 'DELETE' then
          raise exception 'wallets cannot be deleted (wallet %)', old.id
            using errcode = 'restrict_violation';
        end if;

        if new.id <> old.id or new.player_id <> old.player_id
           or new.currency <> old.currency or new.created_at <> old.created_at then
          raise exception 'wallet identity is immutable (wallet %)', old.id
            using errcode = 'restrict_violation';
        end if;

        if new.balance <> old.balance and new.version <> old.version + 1 then
          raise exception 'wallet % balance changed but version went from % to %',
            old.id, old.version, new.version
            using errcode = 'check_violation';
        end if;

        if new.balance = old.balance and new.version <> old.version then
          raise exception 'wallet % version changed without a balance change', old.id
            using errcode = 'check_violation';
        end if;

        return new;
      end;
      $$;
    `);
    this.addSql(`
      create trigger wallets_guard_changes
        before update or delete on wallets
        for each row execute function wallets_guard_changes();
    `);

    // 3. Balance change => matching ledger entry for the new version.
    this.addSql(`
      create function wallets_balance_has_ledger_entry() returns trigger
      language plpgsql as $$
      declare
        expected_before numeric(20, 2);
      begin
        if tg_op = 'INSERT' then
          if new.balance = 0 then
            return null;
          end if;
          expected_before := 0;
        elsif new.balance = old.balance then
          return null;
        else
          expected_before := old.balance;
        end if;

        if not exists (
          select 1
            from wallet_ledger_entries e
           where e.wallet_id = new.id
             and e.wallet_version = new.version
             and e.balance_before = expected_before
             and e.balance_after = new.balance
        ) then
          raise exception 'wallet % balance % (version %) has no matching ledger entry',
            new.id, new.balance, new.version
            using errcode = 'check_violation';
        end if;
        return null;
      end;
      $$;
    `);
    this.addSql(`
      create constraint trigger wallets_balance_has_ledger_entry
        after insert or update of balance on wallets
        deferrable initially deferred
        for each row execute function wallets_balance_has_ledger_entry();
    `);

    // 4. Ledger entry => existing wallet version; the latest entry matches the current balance.
    this.addSql(`
      create function wallet_ledger_entries_match_wallet() returns trigger
      language plpgsql as $$
      declare
        current_version integer;
        current_balance numeric(20, 2);
      begin
        select w.version, w.balance into current_version, current_balance
          from wallets w
         where w.id = new.wallet_id;

        if current_version is null or new.wallet_version > current_version then
          raise exception 'ledger entry % refers to wallet version % beyond the wallet state',
            new.id, new.wallet_version
            using errcode = 'check_violation';
        end if;

        if new.wallet_version = current_version and new.balance_after <> current_balance then
          raise exception 'latest ledger entry % does not match wallet % balance',
            new.id, new.wallet_id
            using errcode = 'check_violation';
        end if;
        return null;
      end;
      $$;
    `);
    this.addSql(`
      create constraint trigger wallet_ledger_entries_match_wallet
        after insert on wallet_ledger_entries
        deferrable initially deferred
        for each row execute function wallet_ledger_entries_match_wallet();
    `);
  }

  override down(): void {
    this.addSql(
      `drop trigger if exists wallet_ledger_entries_match_wallet on wallet_ledger_entries;`,
    );
    this.addSql(`drop function if exists wallet_ledger_entries_match_wallet();`);
    this.addSql(`drop trigger if exists wallets_balance_has_ledger_entry on wallets;`);
    this.addSql(`drop function if exists wallets_balance_has_ledger_entry();`);
    this.addSql(`drop trigger if exists wallets_guard_changes on wallets;`);
    this.addSql(`drop function if exists wallets_guard_changes();`);
    this.addSql(
      `drop trigger if exists wallet_ledger_entries_no_truncate on wallet_ledger_entries;`,
    );
    this.addSql(
      `drop trigger if exists wallet_ledger_entries_no_update_delete on wallet_ledger_entries;`,
    );
    this.addSql(`drop function if exists wallet_ledger_entries_append_only();`);
  }
}
