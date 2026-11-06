import { HttpException, HttpStatus } from '@nestjs/common';
import { ApplicationError, InvalidRequestError } from '../../../application/errors';
import { InvalidMessageError } from '../../../domain/messaging/messaging.errors';
import { InvalidMoneyError } from '../../../domain/money/money.errors';
import { type DomainError } from '../../../domain/shared/domain-error';
import { InvalidWagerTransactionError } from '../../../domain/wagering/wagering.errors';
import { InvalidWalletError } from '../../../domain/wallet/wallet.errors';

export interface HttpErrorBody {
  error: {
    code: string;
    message: string;
    /** Whether the same request may succeed if sent again later. */
    retryable: boolean;
    issues?: readonly { path: string; message: string }[];
  };
}

export interface HttpErrorResponse {
  status: number;
  body: HttpErrorBody;
  retryAfterSeconds?: number;
  /** 5xx are unexpected and logged as errors; 4xx are expected client outcomes. */
  severity: 'error' | 'warn' | 'debug';
}

const TRANSIENT_RETRY_AFTER_SECONDS = 1;

/** Domain errors that mean "the request breaks the input contract", never a server bug. */
const CONTRACT_ERRORS = [
  InvalidMoneyError,
  InvalidWagerTransactionError,
  InvalidMessageError,
  InvalidWalletError,
];

const STATUS_BY_KIND: Readonly<Record<ApplicationError['kind'], number>> = {
  invalid: HttpStatus.BAD_REQUEST,
  not_found: HttpStatus.NOT_FOUND,
  conflict: HttpStatus.CONFLICT,
  transient: HttpStatus.SERVICE_UNAVAILABLE,
  integrity: HttpStatus.INTERNAL_SERVER_ERROR,
};

const CODE_BY_HTTP_STATUS: Readonly<Partial<Record<number, string>>> = {
  [HttpStatus.BAD_REQUEST]: 'INVALID_PAYLOAD',
  [HttpStatus.UNAUTHORIZED]: 'UNAUTHORIZED',
  [HttpStatus.FORBIDDEN]: 'FORBIDDEN',
  [HttpStatus.NOT_FOUND]: 'ROUTE_NOT_FOUND',
  [HttpStatus.METHOD_NOT_ALLOWED]: 'METHOD_NOT_ALLOWED',
  [HttpStatus.PAYLOAD_TOO_LARGE]: 'PAYLOAD_TOO_LARGE',
  [HttpStatus.UNSUPPORTED_MEDIA_TYPE]: 'UNSUPPORTED_MEDIA_TYPE',
};

function body(code: string, message: string, retryable: boolean): HttpErrorBody {
  return { error: { code, message, retryable } };
}

/**
 * Single source of truth for error -> HTTP translation, shared by every endpoint, so providers
 * can decide to resend, fix the payload or give up by status and `code` alone (README §9).
 */
export function toHttpError(error: unknown): HttpErrorResponse {
  if (error instanceof ApplicationError) {
    const status = STATUS_BY_KIND[error.kind];
    if (error.kind === 'integrity') {
      return {
        status,
        body: body(error.code, 'Internal server error', false),
        severity: 'error',
      };
    }
    const response: HttpErrorResponse = {
      status,
      body: body(error.code, error.message, error.kind === 'transient'),
      severity: error.kind === 'transient' ? 'warn' : 'debug',
    };
    if (error instanceof InvalidRequestError && error.issues.length > 0) {
      response.body.error.issues = error.issues;
    }
    if (error.kind === 'transient') response.retryAfterSeconds = TRANSIENT_RETRY_AFTER_SECONDS;
    return response;
  }

  if (CONTRACT_ERRORS.some((type) => error instanceof type)) {
    const domainError = error as DomainError;
    return {
      status: HttpStatus.BAD_REQUEST,
      body: body(domainError.code, domainError.message, false),
      severity: 'debug',
    };
  }

  if (error instanceof HttpException) {
    const status = error.getStatus();
    return {
      status,
      body: body(CODE_BY_HTTP_STATUS[status] ?? `HTTP_${String(status)}`, error.message, false),
      severity: status >= 500 ? 'error' : 'debug',
    };
  }

  // Any other domain error escaping a use case is a programming error, like unknown failures.
  return {
    status: HttpStatus.INTERNAL_SERVER_ERROR,
    body: body('INTERNAL_ERROR', 'Internal server error', false),
    severity: 'error',
  };
}
