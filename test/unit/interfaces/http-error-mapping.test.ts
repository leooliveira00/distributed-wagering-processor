import { NotFoundException, PayloadTooLargeException } from '@nestjs/common';
import { describe, expect, it } from 'bun:test';
import {
  ConflictError,
  IntegrityViolationError,
  InvalidRequestError,
  NotFoundError,
  TransientError,
  UniqueViolationError,
} from '../../../src/application/errors';
import { InvalidMoneyError } from '../../../src/domain/money/money.errors';
import { InvalidTransactionStateError } from '../../../src/domain/wagering/wagering.errors';
import { WagerTransactionStatus } from '../../../src/domain/wagering/wager-transaction-status';
import { toHttpError } from '../../../src/interfaces/http/errors/http-error-mapping';

describe('toHttpError', () => {
  it('maps invalid input to 400 with every issue', () => {
    const mapped = toHttpError(
      new InvalidRequestError('bad', [{ path: 'money.amount', message: 'Required' }]),
    );

    expect(mapped.status).toBe(400);
    expect(mapped.body.error).toEqual({
      code: 'INVALID_PAYLOAD',
      message: 'bad',
      retryable: false,
      issues: [{ path: 'money.amount', message: 'Required' }],
    });
  });

  it('maps domain contract errors to 400 with their own code', () => {
    const mapped = toHttpError(new InvalidMoneyError('nope'));

    expect(mapped.status).toBe(400);
    expect(mapped.body.error.code).toBe('INVALID_MONEY');
  });

  it.each([
    ['not found', new NotFoundError('WALLET_NOT_FOUND', 'x'), 404, 'WALLET_NOT_FOUND'],
    ['conflict', new ConflictError('WALLET_ALREADY_EXISTS', 'x'), 409, 'WALLET_ALREADY_EXISTS'],
    ['unique violation', new UniqueViolationError('some_uq'), 409, 'UNIQUE_VIOLATION'],
  ])('maps %s', (_, error, status, code) => {
    const mapped = toHttpError(error);

    expect(mapped.status).toBe(status);
    expect(mapped.body.error.code).toBe(code);
    expect(mapped.body.error.retryable).toBe(false);
  });

  it('maps transient failures to 503, retryable, with Retry-After', () => {
    const mapped = toHttpError(new TransientError('db down'));

    expect(mapped.status).toBe(503);
    expect(mapped.body.error).toMatchObject({ code: 'SERVICE_UNAVAILABLE', retryable: true });
    expect(mapped.retryAfterSeconds).toBeGreaterThan(0);
    expect(mapped.severity).toBe('warn');
  });

  it('hides integrity violations behind a generic 500 and logs them as errors', () => {
    const mapped = toHttpError(new IntegrityViolationError('wallets_guard', 'internal detail'));

    expect(mapped.status).toBe(500);
    expect(mapped.body.error.message).not.toContain('internal detail');
    expect(mapped.severity).toBe('error');
  });

  it('treats an escaped non-contract domain error as a programming error (500)', () => {
    const mapped = toHttpError(
      new InvalidTransactionStateError(
        'tx-1',
        WagerTransactionStatus.Processed,
        WagerTransactionStatus.Rejected,
      ),
    );

    expect(mapped.status).toBe(500);
    expect(mapped.body.error.code).toBe('INTERNAL_ERROR');
  });

  it.each([
    [new NotFoundException('Cannot GET /nope'), 404, 'ROUTE_NOT_FOUND'],
    [new PayloadTooLargeException(), 413, 'PAYLOAD_TOO_LARGE'],
  ])('keeps framework HTTP errors with a stable code', (error, status, code) => {
    const mapped = toHttpError(error);

    expect(mapped.status).toBe(status);
    expect(mapped.body.error.code).toBe(code);
  });

  it('maps unknown failures to a generic 500 without leaking details', () => {
    const mapped = toHttpError(new Error('secret connection string'));

    expect(mapped.status).toBe(500);
    expect(mapped.body.error).toEqual({
      code: 'INTERNAL_ERROR',
      message: 'Internal server error',
      retryable: false,
    });
  });
});
