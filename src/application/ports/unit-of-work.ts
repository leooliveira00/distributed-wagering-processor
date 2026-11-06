import {
  type InboxRepository,
  type LedgerRepository,
  type OutboxRepository,
  type WagerTransactionRepository,
  type WalletRepository,
} from './repositories';

/** Repositories bound to one SQL transaction. */
export interface TransactionScope {
  wallets: WalletRepository;
  transactions: WagerTransactionRepository;
  ledger: LedgerRepository;
  inbox: InboxRepository;
  outbox: OutboxRepository;
}

/**
 * Runs `work` inside a single SQL transaction: inbox, financial change, ledger and outbox are
 * committed together or not at all (README §6.5, §11). If `work` throws, nothing is persisted.
 */
export interface UnitOfWork {
  run<T>(work: (scope: TransactionScope) => Promise<T>): Promise<T>;
}

export const UNIT_OF_WORK = Symbol('UNIT_OF_WORK');
