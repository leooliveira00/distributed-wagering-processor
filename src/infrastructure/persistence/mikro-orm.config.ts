import { type EntitySchema } from '@mikro-orm/core';
import { Migrator } from '@mikro-orm/migrations';
import { defineConfig, type Options } from '@mikro-orm/postgresql';
import { type Env } from '../config/env';
import { migrations } from './migrations';

/** Entity schemas live in the persistence layer; the domain stays free of ORM metadata. */
export const entitySchemas: EntitySchema[] = [];

export function buildMikroOrmConfig(env: Env): Options {
  return defineConfig({
    host: env.DATABASE_HOST,
    port: env.DATABASE_PORT,
    dbName: env.DATABASE_NAME,
    user: env.DATABASE_USER,
    password: env.DATABASE_PASSWORD,
    pool: { min: 0, max: env.DATABASE_POOL_MAX },
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
