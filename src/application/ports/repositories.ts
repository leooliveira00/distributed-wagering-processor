import { type Money } from '../../domain/money/money';
import { type InboxMessage } from '../../domain/messaging/inbox-message';
import { type OutboxMessage } from '../../domain/messaging/outbox-message';
import { type WagerTransaction } from '../../domain/wagering/wager-transaction';
import { type Wallet } from '../../domain/wallet/wallet';
import { type WalletLedgerEntry } from '../../domain/wallet/wallet-ledger-entry';

/**
 * Persistence ports. Implementations work inside the current unit of work: `add`/`save` register
 * changes and everything is written atomically when the unit of work commits.
 */
export interface WalletRepository {
  findById(id: string): Promise<Wallet | undefined>;
  /** Loads the wallet holding a row lock (SELECT ... FOR UPDATE) until commit. */
  findByIdForUpdate(id: string): Promise<Wallet | undefined>;
  findByPlayerAndCurrency(playerId: string, currency: string): Promise<Wallet | undefined>;
  add(wallet: Wallet): void;
  /** Registers balance changes of a wallet loaded in this unit of work. */
  save(wallet: Wallet): void;
}

export interface WagerTransactionRepository {
  findById(id: string): Promise<WagerTransaction | undefined>;
  findByIdempotencyKey(
    providerId: string,
    idempotencyKey: string,
  ): Promise<WagerTransaction | undefined>;
  findByExternalId(
    providerId: string,
    externalTransactionId: string,
  ): Promise<WagerTransaction | undefined>;
  /** Whether a PROCESSED REFUND or ROLLBACK already targets the given transaction (D6). */
  hasProcessedReversal(referenceTransactionId: string): Promise<boolean>;
  /**
   * Locks and loads the PENDING_REFERENCE transaction due the longest (`next_attempt_at <= now`),
   * with SELECT ... FOR UPDATE SKIP LOCKED: concurrent workers never get the same row and never
   * wait for each other. The lock lasts until the unit of work ends; if it rolls back (crash,
   * error), the row is simply pending again, so no lease is needed.
   */
  lockNextDuePending(now: Date): Promise<WagerTransaction | undefined>;
  /**
   * Makes the PENDING_REFERENCE transactions that reference `externalTransactionId` due right
   * away, so the worker re-evaluates them on its next scan instead of after the backoff. Rows
   * another worker holds are skipped (SKIP LOCKED): this statement never waits for a lock, which
   * keeps the lock order deadlock-free. Returns how many rows were rescheduled.
   */
  expediteDependents(providerId: string, externalTransactionId: string): Promise<number>;
  /**
   * Postpones a pending transaction whose attempt failed unexpectedly, on the database clock,
   * without counting it as a reference attempt. Prevents one bad row from blocking the worker.
   */
  deferPending(id: string, delayMs: number): Promise<void>;
  add(transaction: WagerTransaction): void;
  save(transaction: WagerTransaction): void;
}

export interface LedgerPage {
  entries: WalletLedgerEntry[];
  /** Wallet version of the last returned entry, when more entries may follow. */
  nextAfterVersion: number | undefined;
}

/** Ledger totals of one wallet, aggregated by the database. */
export interface LedgerSummary {
  credits: Money;
  debits: Money;
  entries: number;
}

export interface LedgerRepository {
  add(entry: WalletLedgerEntry): void;
  /** Sums every entry of the wallet; amounts come back exact, in the wallet currency. */
  summarize(walletId: string, currency: string): Promise<LedgerSummary>;
  /** Entries ordered by wallet version; `afterVersion` makes the cursor stable under inserts. */
  listByWallet(
    walletId: string,
    options: { afterVersion?: number; limit: number },
  ): Promise<LedgerPage>;
}

export interface InboxRepository {
  find(consumerName: string, messageId: string): Promise<InboxMessage | undefined>;
  add(message: InboxMessage): void;
}

export interface OutboxRepository {
  add(message: OutboxMessage): void;
  /**
   * Atomically leases up to `limit` due, unpublished messages for `leaseMs` (oldest first).
   * Concurrent publishers never get the same message while its lease holds (SKIP LOCKED); an
   * expired lease, e.g. after a crash, makes the message claimable again. Uses database time,
   * so clock skew between instances cannot break the lease.
   */
  claimDue(options: { limit: number; leaseMs: number }): Promise<OutboxMessage[]>;
  /** Marks messages as published and releases their lease (no-op if already published). */
  markPublished(ids: readonly string[], at: Date): Promise<void>;
  /**
   * Persists a failed attempt and releases the lease. The next attempt time is `now() + delayMs`
   * on the DATABASE clock, the same clock the claim query compares against.
   */
  saveRetry(message: OutboxMessage, delayMs: number): Promise<void>;
}
