import { IsolationLevel } from '@mikro-orm/core';
import { type MikroORM, type SqlEntityManager } from '@mikro-orm/postgresql';
import { LOCK_CONFLICT_REASONS, TransientError } from '../../application/errors';
import { type Metrics } from '../../application/ports/metrics';
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
const NO_METRICS: Metrics = { increment: () => undefined, observe: () => undefined };

export class MikroOrmUnitOfWork implements UnitOfWork {
  /** `metrics` is optional so tests can build a unit of work without instrumentation. */
  constructor(
    private readonly orm: MikroORM,
    private readonly metrics: Metrics = NO_METRICS,
  ) {}

  async run<T>(
    work: (scope: TransactionScope) => Promise<T>,
    options: UnitOfWorkOptions = {},
  ): Promise<T> {
    try {
      return await this.orm.em.fork().transactional(
        (em) => {
          // now() is fixed for the whole SQL transaction, so one round trip is enough.
          let databaseNow: Promise<Date> | undefined;
          return work({
            wallets: new MikroOrmWalletRepository(em),
            transactions: new MikroOrmWagerTransactionRepository(em),
            ledger: new MikroOrmLedgerRepository(em),
            inbox: new MikroOrmInboxRepository(em),
            outbox: new MikroOrmOutboxRepository(em),
            databaseNow: () => (databaseNow ??= readDatabaseNow(em)),
          });
        },
        {
          isolationLevel:
            options.isolation === 'snapshot'
              ? IsolationLevel.REPEATABLE_READ
              : IsolationLevel.READ_COMMITTED,
          readOnly: options.readOnly ?? false,
        },
      );
    } catch (error) {
      const translated = translatePersistenceError(error);
      // Every unit of work goes through here: one place counts all concurrency conflicts.
      if (translated instanceof TransientError && LOCK_CONFLICT_REASONS.has(translated.reason)) {
        this.metrics.increment('db_lock_conflicts_total', { reason: translated.reason });
      }
      throw translated;
    }
  }
}

async function readDatabaseNow(em: SqlEntityManager): Promise<Date> {
  const [row] = await em.execute<{ now: Date }[]>('select now() as now');
  if (!row) throw new Error('select now() returned no row');
  // node-postgres returns timestamptz as a Date; new Date() also copes with a string.
  return new Date(row.now);
}
