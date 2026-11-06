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
  add(transaction: WagerTransaction): void;
  save(transaction: WagerTransaction): void;
}

export interface LedgerPage {
  entries: WalletLedgerEntry[];
  /** Wallet version of the last returned entry, when more entries may follow. */
  nextAfterVersion: number | undefined;
}

export interface LedgerRepository {
  add(entry: WalletLedgerEntry): void;
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
}
