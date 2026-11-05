import { describe, expect, it } from 'bun:test';
import { FailureCode } from '../../../../src/domain/shared/failure-code';
import {
  INTERNAL_PROVIDER_ID,
  WagerTransaction,
} from '../../../../src/domain/wagering/wager-transaction';
import { WagerTransactionStatus as Status } from '../../../../src/domain/wagering/wager-transaction-status';
import {
  InvalidTransactionStateError,
  InvalidWagerTransactionError,
  type InvalidWagerTransactionReason,
} from '../../../../src/domain/wagering/wagering.errors';
import { LedgerDirection } from '../../../../src/domain/wallet/ledger-direction';
import {
  AT,
  HASH,
  Kind,
  LATER,
  brl,
  newTransaction,
  processedTransaction,
  referencing,
} from '../fixtures';

const expectInvalid = (reason: InvalidWagerTransactionReason, create: () => unknown) => {
  try {
    create();
    throw new Error('expected creation to fail');
  } catch (error) {
    expect(error).toBeInstanceOf(InvalidWagerTransactionError);
    expect((error as InvalidWagerTransactionError).code).toBe(reason);
  }
};

describe('WagerTransaction.create', () => {
  it('is born PENDING and not terminal', () => {
    const transaction = newTransaction(Kind.Bet);

    expect(transaction.status).toBe(Status.Pending);
    expect(transaction.isTerminal()).toBe(false);
    expect(transaction.attempts).toBe(0);
    expect(transaction.processedAt).toBeUndefined();
  });

  it('rejects OPENING from outside', () => {
    expectInvalid('UNSUPPORTED_KIND', () => newTransaction(Kind.Opening));
  });

  it.each([Kind.Refund, Kind.Rollback])('requires a reference for %s', (kind) => {
    expectInvalid('REFERENCE_REQUIRED', () => newTransaction(kind));
  });

  it('does not allow a BET to reference anything', () => {
    expectInvalid('REFERENCE_NOT_ALLOWED', () =>
      newTransaction(Kind.Bet, { referenceExternalTransactionId: 'other' }),
    );
  });

  it.each([Kind.Win, Kind.Loss])('accepts %s with or without a reference', (kind) => {
    expect(newTransaction(kind).referenceExternalTransactionId).toBeUndefined();
    expect(
      newTransaction(kind, { referenceExternalTransactionId: 'bet-1' })
        .referenceExternalTransactionId,
    ).toBe('bet-1');
  });

  it('rejects a self reference', () => {
    expectInvalid('SELF_REFERENCE', () =>
      newTransaction(Kind.Refund, {
        externalTransactionId: 'same',
        referenceExternalTransactionId: 'same',
      }),
    );
  });

  it('rejects a zero amount', () => {
    expectInvalid('NON_POSITIVE_AMOUNT', () => newTransaction(Kind.Bet, { money: brl('0.00') }));
  });

  it.each([
    ['blank provider', { providerId: '  ' }],
    ['blank round', { roundId: '' }],
    ['malformed payload hash', { payloadHash: 'not-a-hash' }],
    ['uppercase payload hash', { payloadHash: 'A'.repeat(64) }],
  ])('rejects a %s', (_, overrides) => {
    expectInvalid('INVALID_FIELD', () => newTransaction(Kind.Bet, overrides));
  });
});

describe('WagerTransaction.createOpening', () => {
  it('creates an internal, already processed OPENING credit', () => {
    const opening = WagerTransaction.createOpening({
      id: 'opening-1',
      walletId: 'wallet-1',
      playerId: 'player-1',
      money: brl('1000.00'),
      payloadHash: HASH,
      at: AT,
    });

    expect(opening.kind).toBe(Kind.Opening);
    expect(opening.providerId).toBe(INTERNAL_PROVIDER_ID);
    expect(opening.status).toBe(Status.Processed);
    expect(opening.observedBalance?.equals(brl('1000.00'))).toBe(true);
    expect(opening.ledgerDirectionFor()).toBe(LedgerDirection.Credit);
  });
});

describe('WagerTransaction transitions', () => {
  type Transition = (transaction: WagerTransaction) => void;
  const markProcessed: Transition = (t) => {
    t.markProcessed({ referenceTransactionId: undefined, observedBalance: brl('1.00'), at: AT });
  };
  const markPendingReference: Transition = (t) => {
    t.markPendingReference({ observedBalance: brl('1.00'), nextAttemptAt: LATER });
  };
  const reject: Transition = (t) => {
    t.reject(FailureCode.InsufficientFunds, { observedBalance: brl('1.00') });
  };
  const fail: Transition = (t) => {
    t.fail(FailureCode.ProcessingFailed);
  };

  const transitions: [string, Transition][] = [
    ['markProcessed', markProcessed],
    ['markPendingReference', markPendingReference],
    ['reject', reject],
    ['fail', fail],
  ];
  const terminal: [Status, Transition][] = [
    [Status.Processed, markProcessed],
    [Status.Rejected, reject],
    [Status.Failed, fail],
  ];

  for (const [terminalStatus, reach] of terminal) {
    for (const [name, transition] of transitions) {
      it(`${terminalStatus} is terminal: ${name} throws InvalidTransactionStateError`, () => {
        const transaction = newTransaction(Kind.Bet);
        reach(transaction);

        expect(transaction.status).toBe(terminalStatus);
        expect(transaction.isTerminal()).toBe(true);
        expect(() => {
          transition(transaction);
        }).toThrow(InvalidTransactionStateError);
        expect(transaction.status).toBe(terminalStatus);
      });
    }
  }

  it('PENDING_REFERENCE can be retried, counting attempts, and then processed', () => {
    const transaction = newTransaction(Kind.Refund, { referenceExternalTransactionId: 'bet-1' });
    transaction.markPendingReference({ observedBalance: brl('10.00'), nextAttemptAt: AT });
    transaction.markPendingReference({ observedBalance: brl('10.00'), nextAttemptAt: LATER });

    expect(transaction.status).toBe(Status.PendingReference);
    expect(transaction.attempts).toBe(2);
    expect(transaction.nextAttemptAt).toEqual(LATER);
    expect(transaction.isTerminal()).toBe(false);

    transaction.markProcessed({
      referenceTransactionId: 'tx-bet',
      observedBalance: brl('35.00'),
      at: LATER,
    });
    expect(transaction.status).toBe(Status.Processed);
    expect(transaction.referenceTransactionId).toBe('tx-bet');
    expect(transaction.nextAttemptAt).toBeUndefined();
  });

  it('records failure code and observed balance on rejection', () => {
    const transaction = newTransaction(Kind.Bet);
    transaction.reject(FailureCode.InsufficientFunds, { observedBalance: brl('10.00') });

    expect(transaction.failureCode).toBe(FailureCode.InsufficientFunds);
    expect(transaction.observedBalance?.equals(brl('10.00'))).toBe(true);
  });
});

describe('WagerTransaction domain queries', () => {
  it('detects a divergent payload for the same idempotency key', () => {
    const transaction = newTransaction(Kind.Bet, { payloadHash: 'a'.repeat(64) });

    expect(transaction.matchesPayload('a'.repeat(64))).toBe(true);
    expect(transaction.matchesPayload('b'.repeat(64))).toBe(false);
  });

  it('LOSS is the only operation that does not affect the balance', () => {
    expect(newTransaction(Kind.Loss).affectsBalance()).toBe(false);
    expect(newTransaction(Kind.Bet).affectsBalance()).toBe(true);
    expect(newTransaction(Kind.Win).affectsBalance()).toBe(true);
  });

  it.each([
    [Kind.Bet, LedgerDirection.Debit],
    [Kind.Win, LedgerDirection.Credit],
  ])('%s produces a %s', (kind, direction) => {
    expect(newTransaction(kind).ledgerDirectionFor()).toBe(direction);
  });

  it('REFUND produces a CREDIT', () => {
    const bet = processedTransaction(Kind.Bet);
    expect(referencing(Kind.Refund, bet).ledgerDirectionFor(bet)).toBe(LedgerDirection.Credit);
  });

  it.each([
    [Kind.Bet, LedgerDirection.Credit],
    [Kind.Win, LedgerDirection.Debit],
  ])('ROLLBACK of a %s produces a %s', (referenceKind, direction) => {
    const reference = processedTransaction(referenceKind);
    expect(referencing(Kind.Rollback, reference).ledgerDirectionFor(reference)).toBe(direction);
  });

  it('ROLLBACK of a REFUND produces a DEBIT', () => {
    const bet = processedTransaction(Kind.Bet);
    const refund = processedTransaction(Kind.Refund, {
      referenceExternalTransactionId: bet.externalTransactionId,
    });

    expect(referencing(Kind.Rollback, refund).ledgerDirectionFor(refund)).toBe(
      LedgerDirection.Debit,
    );
  });

  it('ROLLBACK cannot determine a direction without its reference', () => {
    const rollback = newTransaction(Kind.Rollback, { referenceExternalTransactionId: 'x' });
    expect(() => rollback.ledgerDirectionFor()).toThrow();
  });

  it('LOSS has no ledger direction', () => {
    expect(() => newTransaction(Kind.Loss).ledgerDirectionFor()).toThrow();
  });
});

describe('WagerTransaction.rehydrate', () => {
  it('restores state without revalidating transitions', () => {
    const transaction = WagerTransaction.rehydrate({
      id: 'tx-1',
      providerId: 'provider-a',
      externalTransactionId: 'ext-1',
      idempotencyKey: 'provider-a:ext-1',
      payloadHash: HASH,
      walletId: 'wallet-1',
      playerId: 'player-1',
      roundId: 'round-1',
      gameId: 'game-1',
      kind: Kind.Refund,
      money: brl('25.00'),
      referenceExternalTransactionId: 'bet-1',
      createdAt: AT,
      status: Status.Rejected,
      referenceTransactionId: undefined,
      failureCode: FailureCode.ReferenceNotFound,
      processedAt: undefined,
      observedBalance: brl('10.00'),
      attempts: 10,
      nextAttemptAt: undefined,
    });

    expect(transaction.status).toBe(Status.Rejected);
    expect(transaction.failureCode).toBe(FailureCode.ReferenceNotFound);
    expect(transaction.attempts).toBe(10);
    expect(transaction.isTerminal()).toBe(true);
  });
});
