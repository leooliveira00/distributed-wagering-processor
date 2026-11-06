import { IsolationLevel } from '@mikro-orm/core';
import { type MikroORM } from '@mikro-orm/postgresql';
import {
  type TransactionScope,
  type UnitOfWork,
  type UnitOfWorkOptions,
} from '../../application/ports/unit-of-work';
import {
  MikroOrmInboxRepository,
  MikroOrmLedgerRepository,
  MikroOrmOutboxRepository,
  MikroOrmWagerTransactionRepository,
  MikroOrmWalletRepository,
} from './mikro-orm-repositories';
import { translatePersistenceError } from './persistence-errors';

/**
 * One fork of the EntityManager per unit of work: an isolated identity map, so concurrent
 * requests or messages never share loaded state. `transactional()` opens the SQL transaction,
 * flushes every registered change on success and rolls everything back if `work` throws.
 * Persistence failures leave as application errors, so use cases never see ORM types.
 */
export class MikroOrmUnitOfWork implements UnitOfWork {
  constructor(private readonly orm: MikroORM) {}

  async run<T>(
    work: (scope: TransactionScope) => Promise<T>,
    options: UnitOfWorkOptions = {},
  ): Promise<T> {
    try {
      return await this.orm.em.fork().transactional(
        (em) =>
          work({
            wallets: new MikroOrmWalletRepository(em),
            transactions: new MikroOrmWagerTransactionRepository(em),
            ledger: new MikroOrmLedgerRepository(em),
            inbox: new MikroOrmInboxRepository(em),
            outbox: new MikroOrmOutboxRepository(em),
          }),
        {
          isolationLevel:
            options.isolation === 'snapshot'
              ? IsolationLevel.REPEATABLE_READ
              : IsolationLevel.READ_COMMITTED,
          readOnly: options.readOnly ?? false,
        },
      );
    } catch (error) {
      throw translatePersistenceError(error);
    }
  }
}
