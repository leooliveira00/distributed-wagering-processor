import { Migration } from '@mikro-orm/migrations';

/**
 * Core schema. Uniqueness, non-negativity and state consistency are enforced here, not only
 * in application code (README §5.9): a bug or a manual SQL statement cannot break them.
 */
export class Migration20261106000100_initial_schema extends Migration {
  override up(): void {
    this.addSql(`
      create table wallets (
        id          uuid           primary key,
        player_id   uuid           not null,
        currency    char(3)        not null,
        balance     numeric(20, 2) not null,
        -- Starts at 1 (README §6.2); the ORM relies on this default on insert.
        version     integer        not null default 1,
        created_at  timestamptz(3) not null,
        updated_at  timestamptz(3) not null,

        -- At most one wallet per player and currency.
        constraint wallets_player_currency_uq unique (player_id, currency),
        -- Target of the composite foreign key that pins ledger currency to wallet currency.
        constraint wallets_id_currency_uq unique (id, currency),
        constraint wallets_balance_non_negative_ck check (balance >= 0),
        constraint wallets_version_positive_ck check (version >= 1),
        constraint wallets_currency_format_ck check (currency ~ '^[A-Z]{3}$')
      );
    `);

    this.addSql(`
      create table wager_transactions (
        id                                uuid           primary key,
        provider_id                       varchar(64)    not null,
        external_transaction_id           varchar(128)   not null,
        idempotency_key                   varchar(255)   not null,
        payload_hash                      char(64)       not null,
        wallet_id                         uuid           not null references wallets (id),
        player_id                         uuid           not null,
        round_id                          varchar(128)   not null,
        game_id                           varchar(128)   not null,
        kind                              varchar(16)    not null,
        amount                            numeric(20, 2) not null,
        -- No composite FK to the wallet currency on purpose: a CURRENCY_MISMATCH rejection
        -- must still be persisted for auditing and idempotent replay.
        currency                          char(3)        not null,
        reference_external_transaction_id varchar(128),
        reference_transaction_id          uuid           references wager_transactions (id),
        status                            varchar(24)    not null,
        failure_code                      varchar(64),
        -- Wallet balance returned on replays (rule 7.7). Its currency is the wallet's, which differs
        -- from the transaction currency on a CURRENCY_MISMATCH rejection, hence its own column.
        observed_balance                  numeric(20, 2),
        observed_balance_currency         char(3),
        attempts                          integer        not null default 0,
        next_attempt_at                   timestamptz(3),
        created_at                        timestamptz(3) not null,
        processed_at                      timestamptz(3),

        -- Persistent idempotency: the same key or the same provider transaction exists once.
        constraint wager_transactions_idempotency_uq unique (provider_id, idempotency_key),
        constraint wager_transactions_external_uq unique (provider_id, external_transaction_id),
        -- Target of the ledger foreign key: an entry belongs to its transaction's wallet and currency.
        constraint wager_transactions_id_wallet_currency_uq unique (id, wallet_id, currency),

        constraint wager_transactions_kind_ck
          check (kind in ('OPENING', 'BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK')),
        constraint wager_transactions_status_ck
          check (status in ('PENDING', 'PENDING_REFERENCE', 'PROCESSED', 'REJECTED', 'FAILED')),
        constraint wager_transactions_amount_positive_ck check (amount > 0),
        constraint wager_transactions_currency_format_ck check (currency ~ '^[A-Z]{3}$'),
        constraint wager_transactions_payload_hash_format_ck check (payload_hash ~ '^[0-9a-f]{64}$'),
        constraint wager_transactions_observed_balance_ck
          check (observed_balance is null or observed_balance >= 0),
        constraint wager_transactions_observed_balance_currency_ck
          check ((observed_balance is null) = (observed_balance_currency is null)),
        constraint wager_transactions_attempts_ck check (attempts >= 0),

        -- OPENING is internal and only internal transactions are OPENING (README §6.3).
        constraint wager_transactions_opening_internal_ck
          check ((kind = 'OPENING') = (provider_id = 'internal')),
        -- REFUND and ROLLBACK require a reference; BET and OPENING cannot have one.
        constraint wager_transactions_reference_required_ck
          check (kind not in ('REFUND', 'ROLLBACK') or reference_external_transaction_id is not null),
        constraint wager_transactions_reference_forbidden_ck
          check (kind not in ('BET', 'OPENING') or reference_external_transaction_id is null),
        constraint wager_transactions_no_self_reference_ck
          check (reference_transaction_id is null or reference_transaction_id <> id),
        -- A resolved reference is recorded only once the transaction is applied.
        constraint wager_transactions_reference_resolved_ck
          check (reference_transaction_id is null or status = 'PROCESSED'),

        -- State consistency: each field is present exactly in the states that need it.
        constraint wager_transactions_failure_code_ck
          check ((status in ('REJECTED', 'FAILED')) = (failure_code is not null)),
        constraint wager_transactions_processed_at_ck
          check ((status = 'PROCESSED') = (processed_at is not null)),
        constraint wager_transactions_next_attempt_ck
          check ((status = 'PENDING_REFERENCE') = (next_attempt_at is not null))
      );
    `);

    // D6: a reference is reversed at most once in total, by REFUND or ROLLBACK.
    this.addSql(`
      create unique index wager_transactions_single_reversal_uq
        on wager_transactions (reference_transaction_id)
        where status = 'PROCESSED' and kind in ('REFUND', 'ROLLBACK');
    `);
    this.addSql(`
      create unique index wager_transactions_single_opening_uq
        on wager_transactions (wallet_id)
        where kind = 'OPENING';
    `);
    this.addSql(`create index wager_transactions_wallet_idx on wager_transactions (wallet_id);`);
    this.addSql(`
      create index wager_transactions_pending_reference_idx
        on wager_transactions (next_attempt_at)
        where status = 'PENDING_REFERENCE';
    `);

    this.addSql(`
      create table wallet_ledger_entries (
        id              uuid           primary key,
        -- Monotonic sequence: stable, opaque pagination cursor.
        seq             bigint         generated always as identity,
        wallet_id       uuid           not null,
        currency        char(3)        not null,
        transaction_id  uuid           not null,
        direction       varchar(6)     not null,
        amount          numeric(20, 2) not null,
        balance_before  numeric(20, 2) not null,
        balance_after   numeric(20, 2) not null,
        wallet_version  integer        not null,
        created_at      timestamptz(3) not null,

        constraint wallet_ledger_entries_seq_uq unique (seq),
        constraint wallet_ledger_entries_wallet_fk
          foreign key (wallet_id, currency) references wallets (id, currency),
        constraint wallet_ledger_entries_transaction_fk
          foreign key (transaction_id, wallet_id, currency)
          references wager_transactions (id, wallet_id, currency),
        -- A financial transaction produces at most one entry per wallet.
        constraint wallet_ledger_entries_transaction_uq unique (wallet_id, transaction_id),
        -- One entry per wallet version: the ledger is a gap-free chain of balance changes.
        constraint wallet_ledger_entries_version_uq unique (wallet_id, wallet_version),

        constraint wallet_ledger_entries_direction_ck check (direction in ('DEBIT', 'CREDIT')),
        constraint wallet_ledger_entries_amount_positive_ck check (amount > 0),
        constraint wallet_ledger_entries_balances_non_negative_ck
          check (balance_before >= 0 and balance_after >= 0),
        constraint wallet_ledger_entries_version_positive_ck check (wallet_version >= 1),
        constraint wallet_ledger_entries_balanced_ck check (
          (direction = 'CREDIT' and balance_after = balance_before + amount) or
          (direction = 'DEBIT'  and balance_after = balance_before - amount)
        )
      );
    `);
    this.addSql(`
      create index wallet_ledger_entries_wallet_seq_idx on wallet_ledger_entries (wallet_id, seq);
    `);

    this.addSql(`
      create table inbox_messages (
        consumer_name varchar(128)   not null,
        message_id    varchar(255)   not null,
        payload_hash  char(64)       not null,
        received_at   timestamptz(3) not null,
        processed_at  timestamptz(3),

        constraint inbox_messages_pk primary key (consumer_name, message_id),
        constraint inbox_messages_payload_hash_format_ck check (payload_hash ~ '^[0-9a-f]{64}$')
      );
    `);

    this.addSql(`
      create table outbox_messages (
        id              uuid           primary key,
        aggregate_id    varchar(128)   not null,
        event_type      varchar(128)   not null,
        payload         jsonb          not null,
        occurred_at     timestamptz(3) not null,
        attempts        integer        not null default 0,
        next_attempt_at timestamptz(3),
        -- Lease held by the publisher that claimed the message; expired leases are reclaimable.
        locked_until    timestamptz(3),
        published_at    timestamptz(3),

        constraint outbox_messages_attempts_ck check (attempts >= 0)
      );
    `);
    this.addSql(`
      create index outbox_messages_unpublished_idx
        on outbox_messages (occurred_at)
        where published_at is null;
    `);
  }

  override down(): void {
    this.addSql(`drop table if exists outbox_messages;`);
    this.addSql(`drop table if exists inbox_messages;`);
    this.addSql(`drop table if exists wallet_ledger_entries;`);
    this.addSql(`drop table if exists wager_transactions;`);
    this.addSql(`drop table if exists wallets;`);
  }
}
