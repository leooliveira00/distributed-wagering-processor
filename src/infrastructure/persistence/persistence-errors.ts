import {
  ConnectionException,
  DeadlockException,
  LockWaitTimeoutException,
  OptimisticLockError,
  UniqueConstraintViolationException,
} from '@mikro-orm/core';
import {
  IntegrityViolationError,
  TransientError,
  type TransientReason,
  UniqueViolationError,
} from '../../application/errors';

/**
 * Translates persistence failures into application errors. Two shapes reach us:
 * - MikroORM exceptions, for errors raised while flushing statements;
 * - raw `pg` errors (with `code` = SQLSTATE), for errors raised at COMMIT by deferred
 *   constraint triggers, which the ORM does not convert.
 * Anything not recognized is returned unchanged.
 */

const TRANSIENT_SQLSTATES = new Map<string, TransientReason>([
  ['40001', 'serialization'], // serialization_failure
  ['40P01', 'deadlock'], // deadlock_detected
  ['55P03', 'lock_timeout'], // lock_not_available (lock_timeout)
  ['57014', 'statement_timeout'], // query_canceled (statement_timeout)
  ['57P01', 'connection'], // admin_shutdown
  ['08000', 'connection'], // connection_exception
  ['08003', 'connection'], // connection_does_not_exist
  ['08006', 'connection'], // connection_failure
]);
const INTEGRITY_SQLSTATES = new Set(['23514', '23001', '23503', '23502']);
const TRANSIENT_NODE_CODES = new Set(['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EPIPE']);
/**
 * Failures `pg` and `pg-pool` raise without any code, only a fixed message: client timeouts and a
 * connection lost mid-query. Pinned by unit tests, since a driver upgrade could reword them.
 */
const CODELESS_CONNECTION_FAILURES = [
  'Query read timeout',
  'timeout exceeded when trying to connect',
  'Connection terminated due to connection timeout',
  'Connection terminated unexpectedly',
  'Client has encountered a connection error and is not queryable',
];

/** True when the error, or any error in its `cause` chain, is a codeless connection failure. */
function isCodelessConnectionFailure(error: unknown): boolean {
  for (let current = error, depth = 0; current instanceof Error && depth < 5; depth++) {
    const { message } = current;
    if (CODELESS_CONNECTION_FAILURES.some((known) => message.includes(known))) return true;
    current = current.cause;
  }
  return false;
}

interface DriverErrorShape {
  code?: unknown;
  constraint?: unknown;
}

function shapeOf(error: unknown): DriverErrorShape {
  return typeof error === 'object' && error !== null ? error : {};
}

function constraintOf(error: unknown): string | undefined {
  const constraint = shapeOf(error).constraint;
  return typeof constraint === 'string' ? constraint : undefined;
}

function sqlStateOf(error: unknown): string | undefined {
  const code = shapeOf(error).code;
  return typeof code === 'string' ? code : undefined;
}

function ormTransientReason(error: unknown): TransientReason | undefined {
  if (error instanceof OptimisticLockError) return 'optimistic_version';
  if (error instanceof DeadlockException) return 'deadlock';
  if (error instanceof LockWaitTimeoutException) return 'lock_timeout';
  if (error instanceof ConnectionException) return 'connection';
  return undefined;
}

export function translatePersistenceError(error: unknown): unknown {
  if (error instanceof UniqueConstraintViolationException) {
    return new UniqueViolationError(constraintOf(error), { cause: error });
  }
  const ormReason = ormTransientReason(error);
  if (ormReason) {
    return new TransientError('Temporary persistence failure, retry later', {
      cause: error,
      reason: ormReason,
    });
  }

  const sqlState = sqlStateOf(error);
  if (sqlState === '23505') return new UniqueViolationError(constraintOf(error), { cause: error });
  const sqlReason = sqlState === undefined ? undefined : TRANSIENT_SQLSTATES.get(sqlState);
  if (sqlReason) {
    return new TransientError('Temporary persistence failure, retry later', {
      cause: error,
      reason: sqlReason,
    });
  }
  if (
    (sqlState !== undefined && TRANSIENT_NODE_CODES.has(sqlState)) ||
    isCodelessConnectionFailure(error)
  ) {
    return new TransientError('Database unreachable, retry later', {
      cause: error,
      reason: 'connection',
    });
  }
  if (sqlState !== undefined && INTEGRITY_SQLSTATES.has(sqlState)) {
    return new IntegrityViolationError(
      constraintOf(error),
      'A database integrity guarantee rejected the write',
      { cause: error },
    );
  }
  // Unclassified failures keep their original type and end up as 500s: never retried blindly.
  return error;
}
