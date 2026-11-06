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
  UniqueViolationError,
} from '../../application/errors';

/**
 * Translates persistence failures into application errors. Two shapes reach us:
 * - MikroORM exceptions, for errors raised while flushing statements;
 * - raw `pg` errors (with `code` = SQLSTATE), for errors raised at COMMIT by deferred
 *   constraint triggers, which the ORM does not convert.
 * Anything not recognized is returned unchanged.
 */

const TRANSIENT_SQLSTATES = new Set([
  '40001', // serialization_failure
  '40P01', // deadlock_detected
  '55P03', // lock_not_available (lock_timeout)
  '57014', // query_canceled (statement_timeout)
  '57P01', // admin_shutdown
  '08000', // connection_exception
  '08003', // connection_does_not_exist
  '08006', // connection_failure
]);
const INTEGRITY_SQLSTATES = new Set(['23514', '23001', '23503', '23502']);
const TRANSIENT_NODE_CODES = new Set(['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EPIPE']);

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

export function translatePersistenceError(error: unknown): unknown {
  if (error instanceof UniqueConstraintViolationException) {
    return new UniqueViolationError(constraintOf(error), { cause: error });
  }
  if (
    error instanceof OptimisticLockError ||
    error instanceof DeadlockException ||
    error instanceof LockWaitTimeoutException ||
    error instanceof ConnectionException
  ) {
    return new TransientError('Temporary persistence failure, retry later', { cause: error });
  }

  const sqlState = sqlStateOf(error);
  if (sqlState === '23505') return new UniqueViolationError(constraintOf(error), { cause: error });
  if (sqlState !== undefined && TRANSIENT_SQLSTATES.has(sqlState)) {
    return new TransientError('Temporary persistence failure, retry later', { cause: error });
  }
  if (sqlState !== undefined && TRANSIENT_NODE_CODES.has(sqlState)) {
    return new TransientError('Database unreachable, retry later', { cause: error });
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
