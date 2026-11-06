import {
  type EntityClass,
  type EntityManager,
  LockMode,
  type Primary,
  type QueryResult,
} from '@mikro-orm/core';
import { type SqlEntityManager } from '@mikro-orm/postgresql';
import {
  type InboxRepository,
  type LedgerPage,
  type LedgerRepository,
  type LedgerSummary,
  type OutboxRepository,
  type WagerTransactionRepository,
  type WalletRepository,
} from '../../application/ports/repositories';
import { type InboxMessage } from '../../domain/messaging/inbox-message';
import { OutboxMessage } from '../../domain/messaging/outbox-message';
import { Money } from '../../domain/money/money';
import { type WagerTransaction } from '../../domain/wagering/wager-transaction';
import { WagerTransactionKind } from '../../domain/wagering/wager-transaction-kind';
import { WagerTransactionStatus } from '../../domain/wagering/wager-transaction-status';
import { type Wallet } from '../../domain/wallet/wallet';
import { type WalletLedgerEntry } from '../../domain/wallet/wallet-ledger-entry';
import {
  toInboxMessage,
  toLedgerEntry,
  toWagerTransaction,
  toWallet,
  wagerTransactionStateData,
  walletRecordData,
} from './mappers';
import { LedgerEntryRecord } from './records/ledger-entry.record';
import { InboxMessageRecord, OutboxMessageRecord } from './records/messaging.records';
import { WagerTransactionRecord } from './records/wager-transaction.record';
import { WalletRecord } from './records/wallet.record';

/**
 * Repositories over a transactional EntityManager fork. They only register changes in the unit
 * of work; MikroORM writes them on commit, ordered by the relations between records
 * (wallet -> transaction -> ledger entry).
 */

/**
 * Returns the record already loaded or added in this unit of work, straight from the identity
 * map. Saving something that was never loaded would bypass the lock and the version check.
 */
function managed<T extends { id: string }>(
  em: EntityManager,
  entity: EntityClass<T>,
  id: string,
): T {
  const record = em.getUnitOfWork().getById(entity, id as Primary<T>);
  if (!record) {
    throw new Error(`${entity.name} ${id} must be loaded in this unit of work before saving`);
  }
  return record;
}

export class MikroOrmWalletRepository implements WalletRepository {
  constructor(private readonly em: EntityManager) {}

  async findById(id: string): Promise<Wallet | undefined> {
    const record = await this.em.findOne(WalletRecord, { id });
    return record ? toWallet(record) : undefined;
  }

  async findByIdForUpdate(id: string): Promise<Wallet | undefined> {
    const record = await this.em.findOne(
      WalletRecord,
      { id },
      // refresh: the lock query must always hit the database, even if the record is cached.
      { lockMode: LockMode.PESSIMISTIC_WRITE, refresh: true },
    );
    return record ? toWallet(record) : undefined;
  }

  async findByPlayerAndCurrency(playerId: string, currency: string): Promise<Wallet | undefined> {
    const record = await this.em.findOne(WalletRecord, { playerId, currency });
    return record ? toWallet(record) : undefined;
  }

  add(wallet: Wallet): void {
    this.em.persist(this.em.create(WalletRecord, walletRecordData(wallet)));
  }

  save(wallet: Wallet): void {
    const record = managed(this.em, WalletRecord, wallet.id);
    const balance = wallet.balance.toJSON().amount;
    if (balance === record.balance) return;

    // The ORM increments `version` once on flush (UPDATE ... WHERE version = loaded version).
    // The domain must have moved exactly one version, otherwise the two would diverge.
    if (wallet.version !== record.version + 1) {
      throw new Error(
        `Wallet ${wallet.id} moved from version ${String(record.version)} to ${String(wallet.version)} in one unit of work`,
      );
    }
    this.em.assign(record, { balance, updatedAt: wallet.updatedAt });
  }
}

export class MikroOrmWagerTransactionRepository implements WagerTransactionRepository {
  /** SQL-capable manager: rescheduling statements are explicit SQL in the current transaction. */
  constructor(private readonly em: SqlEntityManager) {}

  async findById(id: string): Promise<WagerTransaction | undefined> {
    const record = await this.em.findOne(WagerTransactionRecord, { id });
    return record ? toWagerTransaction(record) : undefined;
  }

  async findByIdempotencyKey(
    providerId: string,
    idempotencyKey: string,
  ): Promise<WagerTransaction | undefined> {
    const record = await this.em.findOne(WagerTransactionRecord, { providerId, idempotencyKey });
    return record ? toWagerTransaction(record) : undefined;
  }

  async findByExternalId(
    providerId: string,
    externalTransactionId: string,
  ): Promise<WagerTransaction | undefined> {
    const record = await this.em.findOne(WagerTransactionRecord, {
      providerId,
      externalTransactionId,
    });
    return record ? toWagerTransaction(record) : undefined;
  }

  async hasProcessedReversal(referenceTransactionId: string): Promise<boolean> {
    const count = await this.em.count(WagerTransactionRecord, {
      referenceTransaction: referenceTransactionId,
      status: WagerTransactionStatus.Processed,
      kind: { $in: [WagerTransactionKind.Refund, WagerTransactionKind.Rollback] },
    });
    return count > 0;
  }

  async lockNextDuePending(now: Date): Promise<WagerTransaction | undefined> {
    // Served by wager_transactions_pending_reference_idx (next_attempt_at, partial on status).
    const record = await this.em.findOne(
      WagerTransactionRecord,
      { status: WagerTransactionStatus.PendingReference, nextAttemptAt: { $lte: now } },
      {
        orderBy: { nextAttemptAt: 'asc', id: 'asc' },
        lockMode: LockMode.PESSIMISTIC_PARTIAL_WRITE, // FOR UPDATE SKIP LOCKED
        refresh: true,
      },
    );
    return record ? toWagerTransaction(record) : undefined;
  }

  async expediteDependents(providerId: string, externalTransactionId: string): Promise<number> {
    // Served by wager_transactions_pending_dependents_idx. `> now()` leaves rows already due alone.
    const result = await this.em.execute<QueryResult>(
      `update wager_transactions
          set next_attempt_at = now()
        where id in (
          select id
            from wager_transactions
           where status = 'PENDING_REFERENCE'
             and provider_id = ?
             and reference_external_transaction_id = ?
             and next_attempt_at > now()
             for update skip locked)`,
      [providerId, externalTransactionId],
      'run',
    );
    return result.affectedRows;
  }

  async deferPending(id: string, delayMs: number): Promise<void> {
    await this.em.execute(
      `update wager_transactions
          set next_attempt_at = now() + make_interval(secs => ? / 1000.0)
        where id = ? and status = 'PENDING_REFERENCE'`,
      [delayMs, id],
    );
  }

  add(transaction: WagerTransaction): void {
    this.em.persist(
      this.em.create(WagerTransactionRecord, {
        id: transaction.id,
        providerId: transaction.providerId,
        externalTransactionId: transaction.externalTransactionId,
        idempotencyKey: transaction.idempotencyKey,
        payloadHash: transaction.payloadHash,
        wallet: this.em.getReference(WalletRecord, transaction.walletId),
        playerId: transaction.playerId,
        roundId: transaction.roundId,
        gameId: transaction.gameId,
        kind: transaction.kind,
        amount: transaction.money.toJSON().amount,
        currency: transaction.money.currency,
        referenceExternalTransactionId: transaction.referenceExternalTransactionId ?? null,
        referenceTransaction: this.referenceOf(transaction),
        createdAt: transaction.createdAt,
        ...wagerTransactionStateData(transaction),
      }),
    );
  }

  save(transaction: WagerTransaction): void {
    const record = managed(this.em, WagerTransactionRecord, transaction.id);
    this.em.assign(record, {
      ...wagerTransactionStateData(transaction),
      referenceTransaction: this.referenceOf(transaction),
    });
  }

  private referenceOf(transaction: WagerTransaction): WagerTransactionRecord | null {
    const id = transaction.referenceTransactionId;
    return id === undefined ? null : this.em.getReference(WagerTransactionRecord, id);
  }
}

export class MikroOrmLedgerRepository implements LedgerRepository {
  /** SQL-capable manager: the summary is an aggregate query run in the current transaction. */
  constructor(private readonly em: SqlEntityManager) {}

  async summarize(walletId: string, currency: string): Promise<LedgerSummary> {
    // Sums run in numeric(38,2) and come back as text, so no value ever passes through a JS number.
    const rows = await this.em.execute<{ credits: string; debits: string; entries: number }[]>(
      `select coalesce(sum(amount) filter (where direction = 'CREDIT'), 0)::numeric(38, 2)::text as credits,
              coalesce(sum(amount) filter (where direction = 'DEBIT'), 0)::numeric(38, 2)::text  as debits,
              count(*)::int as entries
         from wallet_ledger_entries
        where wallet_id = ?`,
      [walletId],
    );
    const row = rows[0];
    if (!row) throw new Error('Ledger summary query returned no row');
    return {
      credits: Money.from({ amount: row.credits, currency }),
      debits: Money.from({ amount: row.debits, currency }),
      entries: row.entries,
    };
  }

  add(entry: WalletLedgerEntry): void {
    this.em.persist(
      this.em.create(LedgerEntryRecord, {
        id: entry.id,
        wallet: this.em.getReference(WalletRecord, entry.walletId),
        currency: entry.money.currency,
        transaction: this.em.getReference(WagerTransactionRecord, entry.transactionId),
        direction: entry.direction,
        amount: entry.money.toJSON().amount,
        balanceBefore: entry.balanceBefore.toJSON().amount,
        balanceAfter: entry.balanceAfter.toJSON().amount,
        walletVersion: entry.walletVersion,
        createdAt: entry.createdAt,
      }),
    );
  }

  async listByWallet(
    walletId: string,
    options: { afterVersion?: number; limit: number },
  ): Promise<LedgerPage> {
    const records = await this.em.find(
      LedgerEntryRecord,
      {
        wallet: walletId,
        ...(options.afterVersion !== undefined
          ? { walletVersion: { $gt: options.afterVersion } }
          : {}),
      },
      // One extra row tells whether another page exists, without a separate count query.
      { orderBy: { walletVersion: 'asc' }, limit: options.limit + 1 },
    );
    const page = records.slice(0, options.limit);
    const hasMore = records.length > options.limit;
    return {
      entries: page.map(toLedgerEntry),
      nextAfterVersion: hasMore ? page.at(-1)?.walletVersion : undefined,
    };
  }
}

export class MikroOrmInboxRepository implements InboxRepository {
  constructor(private readonly em: EntityManager) {}

  async find(consumerName: string, messageId: string): Promise<InboxMessage | undefined> {
    const record = await this.em.findOne(InboxMessageRecord, { consumerName, messageId });
    return record ? toInboxMessage(record) : undefined;
  }

  add(message: InboxMessage): void {
    this.em.persist(
      this.em.create(InboxMessageRecord, {
        consumerName: message.consumerName,
        messageId: message.messageId,
        payloadHash: message.payloadHash,
        receivedAt: message.receivedAt,
        processedAt: message.processedAt ?? null,
      }),
    );
  }
}

interface OutboxRow {
  id: string;
  aggregate_id: string;
  event_type: string;
  payload: Record<string, unknown>;
  occurred_at: Date;
  attempts: number;
  next_attempt_at: Date | null;
  published_at: Date | null;
}

/**
 * Claiming is a single UPDATE ... WHERE id IN (SELECT ... FOR UPDATE SKIP LOCKED) RETURNING:
 * concurrent publishers skip rows another one is claiming instead of waiting for them, and the
 * lease is committed before any network call, so no transaction stays open while publishing.
 * This cannot be expressed through the unit of work, hence explicit SQL.
 */
export class MikroOrmOutboxRepository implements OutboxRepository {
  constructor(private readonly em: SqlEntityManager) {}

  async claimDue(options: { limit: number; leaseMs: number }): Promise<OutboxMessage[]> {
    const rows = await this.em.execute<OutboxRow[]>(
      `update outbox_messages
          set locked_until = now() + make_interval(secs => ? / 1000.0)
        where id in (
          select id
            from outbox_messages
           where published_at is null
             and (next_attempt_at is null or next_attempt_at <= now())
             and (locked_until is null or locked_until < now())
           order by occurred_at, id
           limit ?
           for update skip locked)
        returning id, aggregate_id, event_type, payload, occurred_at, attempts,
                  next_attempt_at, published_at`,
      [options.leaseMs, options.limit],
    );
    return rows
      .map((row) =>
        OutboxMessage.rehydrate({
          id: row.id,
          aggregateId: row.aggregate_id,
          eventType: row.event_type,
          payload: row.payload,
          occurredAt: row.occurred_at,
          attempts: row.attempts,
          nextAttemptAt: row.next_attempt_at ?? undefined,
          publishedAt: row.published_at ?? undefined,
        }),
      )
      .sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime() || a.id.localeCompare(b.id));
  }

  async markPublished(ids: readonly string[], at: Date): Promise<void> {
    if (ids.length === 0) return;
    await this.em.execute(
      `update outbox_messages
          set published_at = ?, locked_until = null, next_attempt_at = null
        where id in (?) and published_at is null`,
      // MikroORM expands an array bound to a single `?` into a comma-separated list.
      [at, [...ids]],
    );
  }

  async saveRetry(message: OutboxMessage, delayMs: number): Promise<void> {
    await this.em.execute(
      `update outbox_messages
          set attempts = ?, next_attempt_at = now() + make_interval(secs => ? / 1000.0),
              locked_until = null
        where id = ? and published_at is null`,
      [message.attempts, delayMs, message.id],
    );
  }

  add(message: OutboxMessage): void {
    this.em.persist(
      this.em.create(OutboxMessageRecord, {
        id: message.id,
        aggregateId: message.aggregateId,
        eventType: message.eventType,
        // The domain payload is frozen; the ORM gets its own copy to track.
        payload: structuredClone(message.payload),
        occurredAt: message.occurredAt,
        attempts: message.attempts,
        nextAttemptAt: message.nextAttemptAt ?? null,
        lockedUntil: null,
        publishedAt: message.publishedAt ?? null,
      }),
    );
  }
}
