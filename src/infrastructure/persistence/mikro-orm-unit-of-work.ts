import { type MikroORM } from '@mikro-orm/core';
import { type TransactionScope, type UnitOfWork } from '../../application/ports/unit-of-work';
import {
  MikroOrmInboxRepository,
  MikroOrmLedgerRepository,
  MikroOrmOutboxRepository,
  MikroOrmWagerTransactionRepository,
  MikroOrmWalletRepository,
} from './mikro-orm-repositories';

/**
 * One fork of the EntityManager per unit of work: an isolated identity map, so concurrent
 * requests or messages never share loaded state. `transactional()` opens the SQL transaction,
 * flushes every registered change on success and rolls everything back if `work` throws.
 */
export class MikroOrmUnitOfWork implements UnitOfWork {
  constructor(private readonly orm: MikroORM) {}

  run<T>(work: (scope: TransactionScope) => Promise<T>): Promise<T> {
    return this.orm.em.fork().transactional((em) =>
      work({
        wallets: new MikroOrmWalletRepository(em),
        transactions: new MikroOrmWagerTransactionRepository(em),
        ledger: new MikroOrmLedgerRepository(em),
        inbox: new MikroOrmInboxRepository(em),
        outbox: new MikroOrmOutboxRepository(em),
      }),
    );
  }
}
