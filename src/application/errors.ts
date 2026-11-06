/**
 * Application-level failures. Each carries a stable `code` and a `kind` the interfaces map to
 * transport semantics (HTTP status, SQS ack/retry/DLQ) consistently, without parsing messages.
 */
export type ApplicationErrorKind =
  /** Malformed or contract-violating input. Fix the request; never retry as is. */
  | 'invalid'
  /** The referenced resource does not exist. */
  | 'not_found'
  /** The request conflicts with existing state (duplicate wallet, idempotency key reuse). */
  | 'conflict'
  /** Temporary infrastructure failure. Safe to retry with backoff. */
  | 'transient'
  /** A database integrity guarantee rejected the write: a programming error, never retried. */
  | 'integrity';

export abstract class ApplicationError extends Error {
  abstract readonly kind: ApplicationErrorKind;

  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export interface ValidationIssue {
  path: string;
  message: string;
}

export class InvalidRequestError extends ApplicationError {
  readonly kind = 'invalid';

  constructor(
    message: string,
    readonly issues: readonly ValidationIssue[] = [],
    code = 'INVALID_PAYLOAD',
  ) {
    super(code, message);
  }
}

export class NotFoundError extends ApplicationError {
  readonly kind = 'not_found';
}

export class ConflictError extends ApplicationError {
  readonly kind = 'conflict';
}

export class TransientError extends ApplicationError {
  readonly kind = 'transient';

  constructor(message: string, options?: { cause?: unknown }) {
    super('SERVICE_UNAVAILABLE', message);
    if (options?.cause !== undefined) this.cause = options.cause;
  }
}

export class IntegrityViolationError extends ApplicationError {
  readonly kind = 'integrity';

  constructor(
    readonly constraint: string | undefined,
    message: string,
    options?: { cause?: unknown },
  ) {
    super('INTEGRITY_VIOLATION', message);
    if (options?.cause !== undefined) this.cause = options.cause;
  }
}

/**
 * A unique constraint rejected the write. Raised to use cases (not mapped directly) because
 * several races are resolved by re-reading: duplicate wallet, concurrent idempotent submissions.
 */
export class UniqueViolationError extends ApplicationError {
  readonly kind = 'conflict';

  constructor(
    readonly constraint: string | undefined,
    options?: { cause?: unknown },
  ) {
    super('UNIQUE_VIOLATION', `Unique constraint violated: ${constraint ?? 'unknown'}`);
    if (options?.cause !== undefined) this.cause = options.cause;
  }
}
