import { Migrator } from '@mikro-orm/migrations';
import { defineConfig, type Options } from '@mikro-orm/postgresql';
import { type Env } from '../config/env';
import { migrations } from './migrations';
import { LedgerEntrySchema } from './records/ledger-entry.record';
import { InboxMessageSchema, OutboxMessageSchema } from './records/messaging.records';
import { WagerTransactionSchema } from './records/wager-transaction.record';
import { WalletSchema } from './records/wallet.record';

/** Entity schemas live in the persistence layer; the domain stays free of ORM metadata. */
export const entitySchemas = [
  WalletSchema,
  WagerTransactionSchema,
  LedgerEntrySchema,
  InboxMessageSchema,
  OutboxMessageSchema,
];

export function buildMikroOrmConfig(env: Env): Options {
  return defineConfig({
    host: env.DATABASE_HOST,
    port: env.DATABASE_PORT,
    dbName: env.DATABASE_NAME,
    user: env.DATABASE_USER,
    password: env.DATABASE_PASSWORD,
    pool: { min: 0, max: env.DATABASE_POOL_MAX },
    // Sent by `pg` as startup parameters of every pooled connection: a hot wallet can never make
    // a request wait indefinitely for the row lock.
    driverOptions: {
      lock_timeout: env.DATABASE_LOCK_TIMEOUT_MS,
      statement_timeout: env.DATABASE_STATEMENT_TIMEOUT_MS,
    },
    entities: entitySchemas,
    discovery: { warnWhenNoEntities: false },
    extensions: [Migrator],
    migrations: {
      migrationsList: migrations,
      tableName: 'mikro_orm_migrations',
      // Migrations are hand-written SQL: constraints, partial indexes and triggers are part of the evaluated design.
      snapshot: false,
      snapshotOnMigrate: false,
      transactional: true,
      allOrNothing: true,
    },
    debug: env.LOG_LEVEL === 'debug' || env.LOG_LEVEL === 'trace',
  });
}
