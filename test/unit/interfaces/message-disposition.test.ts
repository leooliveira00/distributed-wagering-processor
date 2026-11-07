import { describe, expect, it } from 'bun:test';
import {
  ConflictError,
  IntegrityViolationError,
  InvalidRequestError,
  NotFoundError,
  TransientError,
} from '../../../src/application/errors';
import { type WagerSubmissionResult } from '../../../src/application/wagering/wager-views';
import { InvalidMoneyError } from '../../../src/domain/money/money.errors';
import { FailureCode } from '../../../src/domain/shared/failure-code';
import { WagerTransactionStatus as Status } from '../../../src/domain/wagering/wager-transaction-status';
import {
  InvalidTransactionStateError,
  InvalidWagerTransactionError,
} from '../../../src/domain/wagering/wagering.errors';
import {
  dispositionOfError,
  dispositionOfResult,
} from '../../../src/interfaces/sqs/message-disposition';

const result = (overrides: Partial<WagerSubmissionResult>): WagerSubmissionResult => ({
  transactionId: 'tx-1',
  status: Status.Processed,
  balance: { amount: '75.00', currency: 'BRL' },
  idempotentReplay: false,
  failureCode: null,
  ...overrides,
});

describe('dispositionOfResult', () => {
  it.each([
    [Status.Processed, 'processed'],
    [Status.PendingReference, 'pending_reference'],
    [Status.Rejected, 'rejected'],
    [Status.Failed, 'failed'], // terminal: redelivering the message cannot change it
  ] as const)('acks a %s transaction', (status, outcome) => {
    expect(dispositionOfResult(result({ status }))).toEqual({ action: 'ack', outcome });
  });

  it('acks a business rejection: it is persisted and auditable', () => {
    expect(
      dispositionOfResult(
        result({ status: Status.Rejected, failureCode: FailureCode.InsufficientFunds }),
      ),
    ).toEqual({ action: 'ack', outcome: 'rejected' });
  });

  it('acks a replay as a duplicate', () => {
    expect(dispositionOfResult(result({ idempotentReplay: true }))).toEqual({
      action: 'ack',
      outcome: 'duplicate',
    });
  });
});

describe('dispositionOfError', () => {
  it('acks business conflicts: the original transaction is intact', () => {
    expect(dispositionOfError(new ConflictError('IDEMPOTENCY_KEY_CONFLICT', 'x'))).toEqual({
      action: 'ack',
      outcome: 'conflict',
    });
  });

  it.each([
    [
      'an invalid request',
      new InvalidRequestError('x', [], 'RESERVED_PROVIDER'),
      'RESERVED_PROVIDER',
    ],
    ['an invalid amount', new InvalidMoneyError('x'), 'INVALID_MONEY'],
    [
      'a missing reference',
      new InvalidWagerTransactionError('REFERENCE_REQUIRED', 'x'),
      'REFERENCE_REQUIRED',
    ],
  ])('dead-letters %s immediately as invalid payload', (_, error, code) => {
    expect(dispositionOfError(error)).toEqual({
      action: 'dead-letter',
      reason: 'invalid_payload',
      code,
    });
  });

  it('dead-letters an unknown wallet: nothing was persisted, keep it auditable', () => {
    expect(dispositionOfError(new NotFoundError('WALLET_NOT_FOUND', 'x'))).toEqual({
      action: 'dead-letter',
      reason: 'wallet_not_found',
      code: 'WALLET_NOT_FOUND',
    });
  });

  it('dead-letters an integrity violation: retrying a bug cannot help', () => {
    expect(dispositionOfError(new IntegrityViolationError('x_ck', 'x'))).toMatchObject({
      action: 'dead-letter',
      reason: 'integrity_violation',
    });
  });

  it('retries a transient failure', () => {
    expect(dispositionOfError(new TransientError('db down'))).toEqual({
      action: 'retry',
      reason: 'transient',
      code: 'SERVICE_UNAVAILABLE',
    });
  });

  it.each([
    ['an unknown error', new Error('boom')],
    [
      'a non-contract domain error',
      new InvalidTransactionStateError('tx', Status.Processed, Status.Rejected),
    ],
  ])('never swallows %s: retried, then dead-lettered by the redrive policy', (_, error) => {
    expect(dispositionOfError(error)).toEqual({
      action: 'retry',
      reason: 'unexpected',
      code: 'UNEXPECTED_ERROR',
    });
  });
});
