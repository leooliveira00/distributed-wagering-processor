import { MikroORM } from '@mikro-orm/postgresql';
import { SQL } from 'bun';
import { expect } from 'bun:test';
import { type Env, loadEnv } from '../../../src/infrastructure/config/env';
import { buildMikroOrmConfig } from '../../../src/infrastructure/persistence/mikro-orm.config';

export interface TestDatabase {
  name: string;
  env: Env;
  orm: MikroORM;
  /** Raw client that bypasses the ORM and the application entirely. */
  sql: SQL;
  close(): Promise<void>;
}

const baseEnv = loadEnv();

function connectionUrl(database: string): string {
  const user = encodeURIComponent(baseEnv.DATABASE_USER);
  const password = encodeURIComponent(baseEnv.DATABASE_PASSWORD);
  return `postgres://${user}:${password}@${baseEnv.DATABASE_HOST}:${String(baseEnv.DATABASE_PORT)}/${database}`;
}

/**
 * Creates an isolated, disposable database for one test suite. Each suite gets a fresh schema,
 * so tests never need to clean up (the ledger is append-only and cannot be truncated anyway).
 * Requires the compose PostgreSQL: `docker compose up -d postgres`.
 */
export async function createTestDatabase(
  suite: string,
  options: { migrate?: boolean } = {},
): Promise<TestDatabase> {
  const name = `wagering_test_${suite.toLowerCase().replace(/[^a-z0-9]+/g, '_')}`;

  const admin = new SQL(connectionUrl(baseEnv.DATABASE_NAME));
  try {
    await admin.unsafe(`drop database if exists ${name} with (force)`);
    await admin.unsafe(`create database ${name}`);
  } finally {
    await admin.close();
  }

  const env: Env = { ...baseEnv, DATABASE_NAME: name, LOG_LEVEL: 'warn' };
  const config = buildMikroOrmConfig(env);
  const orm = await MikroORM.init({
    ...config,
    migrations: { ...config.migrations, silent: true },
  });
  if (options.migrate ?? true) await orm.migrator.up();

  const sql = new SQL(connectionUrl(name));
  return {
    name,
    env,
    orm,
    sql,
    async close() {
      await sql.close();
      await orm.close();
    },
  };
}

/** Awaits an operation that must fail and returns its error for synchronous assertions. */
export async function captureError(operation: Promise<unknown>): Promise<unknown> {
  try {
    await operation;
  } catch (error) {
    return error;
  }
  throw new Error('expected the operation to fail, but it succeeded');
}

/** Asserts that a statement fails with the given SQLSTATE and, optionally, constraint or message. */
export async function expectPgError(
  action: () => Promise<unknown>,
  expected: { sqlState: string; constraint?: string; message?: RegExp },
): Promise<void> {
  let error: unknown;
  try {
    await action();
  } catch (caught) {
    error = caught;
  }
  if (error === undefined) throw new Error('expected the statement to fail, but it succeeded');

  const pgError = error as { errno?: string; constraint?: string; message: string };
  expect(pgError.errno).toBe(expected.sqlState);
  if (expected.constraint !== undefined) expect(pgError.constraint).toBe(expected.constraint);
  if (expected.message !== undefined) expect(pgError.message).toMatch(expected.message);
}

/** PostgreSQL SQLSTATE codes used by the schema. */
export const SqlState = {
  UniqueViolation: '23505',
  ForeignKeyViolation: '23503',
  CheckViolation: '23514',
  RestrictViolation: '23001',
} as const;
