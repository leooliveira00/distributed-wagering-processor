import { describe, expect, it } from 'bun:test';
import { FailureCode } from '../../../../src/domain/shared/failure-code';
import { type WagerTransaction } from '../../../../src/domain/wagering/wager-transaction';
import {
  type MissingReferencePolicy,
  WagerTransactionProcessor,
} from '../../../../src/domain/wagering/wager-transaction-processor';
import { WagerTransactionStatus as Status } from '../../../../src/domain/wagering/wager-transaction-status';
import { LedgerDirection } from '../../../../src/domain/wallet/ledger-direction';
import { type Wallet } from '../../../../src/domain/wallet/wallet';
import {
  AT,
  Kind,
  LATER,
  brl,
  newTransaction,
  nextId,
  openWallet,
  processedTransaction,
  referencing,
  usd,
} from '../fixtures';

const processor = new WagerTransactionProcessor();
const RETRY: MissingReferencePolicy = { action: 'retry', nextAttemptAt: LATER };

function run(
  transaction: WagerTransaction,
  wallet: Wallet,
  options: {
    reference?: WagerTransaction;
    alreadyReversed?: boolean;
    missingReference?: MissingReferencePolicy;
  } = {},
) {
  return processor.process({
    transaction,
    wallet,
    reference: options.reference,
    referenceAlreadyReversed: options.alreadyReversed ?? false,
    missingReference: options.missingReference ?? RETRY,
    ledgerEntryId: nextId('entry'),
    at: AT,
  });
}

/**
 * Runs the processor and asserts a rejection: no ledger entry, and balance and version
 * untouched (rule 7.6). The observed balance is the one at rejection time (rule 7.7).
 */
function expectRejected(
  transaction: WagerTransaction,
  wallet: Wallet,
  failureCode: FailureCode,
  execute: () => ReturnType<typeof run>,
) {
  const balanceBefore = wallet.balance;
  const versionBefore = wallet.version;

  const outcome = execute();

  expect(outcome).toEqual({ status: Status.Rejected, failureCode });
  expect(transaction.status).toBe(Status.Rejected);
  expect(transaction.failureCode).toBe(failureCode);
  expect(wallet.balance.equals(balanceBefore)).toBe(true);
  expect(wallet.version).toBe(versionBefore);
  expect(transaction.observedBalance?.equals(balanceBefore)).toBe(true);
}

describe('BET', () => {
  it('debits the wallet with one DEBIT entry', () => {
    const wallet = openWallet('100.00');
    const bet = newTransaction(Kind.Bet, { money: brl('25.00') });

    const outcome = run(bet, wallet);

    expect(outcome.status).toBe(Status.Processed);
    if (outcome.status !== Status.Processed) return;
    expect(outcome.ledgerEntry?.direction).toBe(LedgerDirection.Debit);
    expect(wallet.balance.equals(brl('75.00'))).toBe(true);
    expect(bet.status).toBe(Status.Processed);
    expect(bet.observedBalance?.equals(brl('75.00'))).toBe(true);
  });

  it('is rejected with INSUFFICIENT_FUNDS when the balance is not enough', () => {
    const wallet = openWallet('20.00');
    const bet = newTransaction(Kind.Bet, { money: brl('25.00') });

    expectRejected(bet, wallet, FailureCode.InsufficientFunds, () => run(bet, wallet));
    expect(wallet.balance.equals(brl('20.00'))).toBe(true);
    expect(wallet.version).toBe(1);
  });

  it('section 8 scenario (sequential, in memory): 100.00 and two BETs of 80.00', () => {
    const wallet = openWallet('100.00');
    const first = newTransaction(Kind.Bet, { money: brl('80.00') });
    const second = newTransaction(Kind.Bet, { money: brl('80.00') });

    const outcomes = [run(first, wallet), run(second, wallet)];

    expect(outcomes.map((o) => o.status)).toEqual([Status.Processed, Status.Rejected]);
    expect(second.failureCode).toBe(FailureCode.InsufficientFunds);
    expect(wallet.balance.equals(brl('20.00'))).toBe(true);
    expect(outcomes.filter((o) => o.status === Status.Processed && o.ledgerEntry)).toHaveLength(1);
  });
});

describe('WIN', () => {
  it('credits the wallet without a reference', () => {
    const wallet = openWallet('100.00');
    const outcome = run(newTransaction(Kind.Win, { money: brl('50.00') }), wallet);

    expect(outcome.status).toBe(Status.Processed);
    expect(wallet.balance.equals(brl('150.00'))).toBe(true);
  });

  it('links to the BET of the same round when referenced', () => {
    const wallet = openWallet('100.00');
    const bet = processedTransaction(Kind.Bet);
    const win = referencing(Kind.Win, bet, { money: brl('60.00') });

    expect(run(win, wallet, { reference: bet }).status).toBe(Status.Processed);
    expect(win.referenceTransactionId).toBe(bet.id);
  });

  it('waits as PENDING_REFERENCE when the referenced BET has not arrived', () => {
    const wallet = openWallet('100.00');
    const win = newTransaction(Kind.Win, { referenceExternalTransactionId: 'bet-later' });

    expect(run(win, wallet).status).toBe(Status.PendingReference);
    expect(wallet.balance.equals(brl('100.00'))).toBe(true);
  });

  it('cannot reference anything other than a BET', () => {
    const wallet = openWallet('100.00');
    const loss = processedTransaction(Kind.Loss);
    const win = referencing(Kind.Win, loss);

    expectRejected(win, wallet, FailureCode.ReferenceKindNotAllowed, () =>
      run(win, wallet, { reference: loss }),
    );
  });
});

describe('LOSS', () => {
  it('is processed without moving the balance or creating a ledger entry', () => {
    const wallet = openWallet('100.00');
    const loss = newTransaction(Kind.Loss);

    const outcome = run(loss, wallet);

    expect(outcome).toEqual({ status: Status.Processed, ledgerEntry: undefined });
    expect(wallet.balance.equals(brl('100.00'))).toBe(true);
    expect(wallet.version).toBe(1);
    expect(loss.observedBalance?.equals(brl('100.00'))).toBe(true);
  });
});

describe('REFUND', () => {
  it('credits back the amount of a processed BET', () => {
    const wallet = openWallet('75.00');
    const bet = processedTransaction(Kind.Bet, { money: brl('25.00') });
    const refund = referencing(Kind.Refund, bet);

    const outcome = run(refund, wallet, { reference: bet });

    expect(outcome.status).toBe(Status.Processed);
    expect(wallet.balance.equals(brl('100.00'))).toBe(true);
    expect(refund.referenceTransactionId).toBe(bet.id);
  });

  it('waits as PENDING_REFERENCE when it arrives before the BET', () => {
    const wallet = openWallet('75.00');
    const refund = newTransaction(Kind.Refund, { referenceExternalTransactionId: 'bet-later' });

    expect(run(refund, wallet).status).toBe(Status.PendingReference);
    expect(refund.attempts).toBe(1);
    expect(refund.nextAttemptAt).toEqual(LATER);
  });

  it('only references a BET', () => {
    const wallet = openWallet('100.00');
    const win = processedTransaction(Kind.Win);
    const refund = referencing(Kind.Refund, win);

    expectRejected(refund, wallet, FailureCode.ReferenceKindNotAllowed, () =>
      run(refund, wallet, { reference: win }),
    );
  });

  it('must match the BET amount (no partial reversal)', () => {
    const wallet = openWallet('100.00');
    const bet = processedTransaction(Kind.Bet, { money: brl('25.00') });
    const refund = referencing(Kind.Refund, bet, { money: brl('10.00') });

    expectRejected(refund, wallet, FailureCode.ReferenceAmountMismatch, () =>
      run(refund, wallet, { reference: bet }),
    );
  });

  it('cannot reverse a BET that was already reversed', () => {
    const wallet = openWallet('100.00');
    const bet = processedTransaction(Kind.Bet);
    const refund = referencing(Kind.Refund, bet);

    expectRejected(refund, wallet, FailureCode.ReferenceAlreadyReversed, () =>
      run(refund, wallet, { reference: bet, alreadyReversed: true }),
    );
  });

  it('cannot reverse a BET that was rejected', () => {
    const wallet = openWallet('100.00');
    const bet = newTransaction(Kind.Bet);
    bet.reject(FailureCode.InsufficientFunds, { observedBalance: brl('1.00') });
    const refund = referencing(Kind.Refund, bet);

    expectRejected(refund, wallet, FailureCode.ReferenceNotProcessed, () =>
      run(refund, wallet, { reference: bet }),
    );
  });

  it('keeps waiting while the reference itself is still pending', () => {
    const wallet = openWallet('100.00');
    const win = newTransaction(Kind.Win, { referenceExternalTransactionId: 'bet-later' });
    win.markPendingReference({ observedBalance: brl('100.00'), nextAttemptAt: LATER });
    const rollback = referencing(Kind.Rollback, win);

    expect(run(rollback, wallet, { reference: win }).status).toBe(Status.PendingReference);
  });
});

describe('ROLLBACK', () => {
  it('of a BET credits the amount back', () => {
    const wallet = openWallet('75.00');
    const bet = processedTransaction(Kind.Bet, { money: brl('25.00') });

    run(referencing(Kind.Rollback, bet), wallet, { reference: bet });

    expect(wallet.balance.equals(brl('100.00'))).toBe(true);
  });

  it('of a WIN debits the amount back', () => {
    const wallet = openWallet('160.00');
    const win = processedTransaction(Kind.Win, { money: brl('60.00') });

    const outcome = run(referencing(Kind.Rollback, win), wallet, { reference: win });

    expect(outcome.status).toBe(Status.Processed);
    if (outcome.status !== Status.Processed) return;
    expect(outcome.ledgerEntry?.direction).toBe(LedgerDirection.Debit);
    expect(wallet.balance.equals(brl('100.00'))).toBe(true);
  });

  it('of a REFUND debits the amount back', () => {
    const wallet = openWallet('100.00');
    const bet = processedTransaction(Kind.Bet);
    const refund = processedTransaction(Kind.Refund, {
      referenceExternalTransactionId: bet.externalTransactionId,
    });

    run(referencing(Kind.Rollback, refund), wallet, { reference: refund });

    expect(wallet.balance.equals(brl('75.00'))).toBe(true);
  });

  it('cannot reference a LOSS', () => {
    const wallet = openWallet('100.00');
    const loss = processedTransaction(Kind.Loss);
    const rollback = referencing(Kind.Rollback, loss);

    expectRejected(rollback, wallet, FailureCode.ReferenceKindNotAllowed, () =>
      run(rollback, wallet, { reference: loss }),
    );
  });

  it('that would make the balance negative is rejected with a code distinct from a BET', () => {
    const wallet = openWallet('10.00');
    const win = processedTransaction(Kind.Win, { money: brl('60.00') });
    const rollback = referencing(Kind.Rollback, win);

    expectRejected(rollback, wallet, FailureCode.ReversalInsufficientFunds, () =>
      run(rollback, wallet, { reference: win }),
    );
    expect(FailureCode.ReversalInsufficientFunds).not.toBe(FailureCode.InsufficientFunds);
    expect(wallet.balance.equals(brl('10.00'))).toBe(true);
  });

  it('cannot reverse a reference that was already reversed by a REFUND (D6)', () => {
    const wallet = openWallet('100.00');
    const bet = processedTransaction(Kind.Bet);
    const rollback = referencing(Kind.Rollback, bet);

    expectRejected(rollback, wallet, FailureCode.ReferenceAlreadyReversed, () =>
      run(rollback, wallet, { reference: bet, alreadyReversed: true }),
    );
  });
});

describe('context validation', () => {
  it('rejects a player that does not own the wallet', () => {
    const wallet = openWallet('100.00');
    const bet = newTransaction(Kind.Bet, { playerId: 'someone-else' });

    expectRejected(bet, wallet, FailureCode.PlayerWalletMismatch, () => run(bet, wallet));
  });

  it('rejects an operation in a different currency than the wallet', () => {
    const wallet = openWallet('100.00');
    const bet = newTransaction(Kind.Bet, { money: usd('25.00') });

    expectRejected(bet, wallet, FailureCode.CurrencyMismatch, () => run(bet, wallet));
    expect(wallet.balance.equals(brl('100.00'))).toBe(true);
  });

  it.each([
    ['round', { roundId: 'another-round' }],
    ['provider', { providerId: 'provider-b' }],
    ['player', { playerId: 'player-2' }],
  ])('rejects a reference from a different %s', (_, referenceOverrides) => {
    const wallet = openWallet('100.00');
    const bet = processedTransaction(Kind.Bet, referenceOverrides);
    const refund = referencing(Kind.Refund, bet);

    expectRejected(refund, wallet, FailureCode.ReferenceContextMismatch, () =>
      run(refund, wallet, { reference: bet }),
    );
  });

  it('rejects a reference from a different wallet', () => {
    const wallet = openWallet('100.00');
    const bet = processedTransaction(Kind.Bet, { walletId: 'wallet-2' });
    const refund = referencing(Kind.Refund, bet);

    expectRejected(refund, wallet, FailureCode.ReferenceContextMismatch, () =>
      run(refund, wallet, { reference: bet }),
    );
  });

  it('refuses to process a transaction against a wallet it does not belong to', () => {
    const wallet = openWallet('100.00');
    const bet = newTransaction(Kind.Bet, { walletId: 'wallet-2' });

    expect(() => run(bet, wallet)).toThrow();
  });
});

describe('missing reference policy', () => {
  it('rejects with REFERENCE_NOT_FOUND once retries are exhausted', () => {
    const wallet = openWallet('100.00');
    const refund = newTransaction(Kind.Refund, { referenceExternalTransactionId: 'never' });

    expectRejected(refund, wallet, FailureCode.ReferenceNotFound, () =>
      run(refund, wallet, { missingReference: { action: 'reject' } }),
    );
  });

  it('counts the final attempt, so attempts equals the limit after exhaustion', () => {
    const wallet = openWallet('100.00');
    const refund = newTransaction(Kind.Refund, { referenceExternalTransactionId: 'never' });

    run(refund, wallet); // attempt 1: waits
    run(refund, wallet); // attempt 2: waits
    run(refund, wallet, { missingReference: { action: 'reject' } }); // attempt 3: gives up

    expect(refund.status).toBe(Status.Rejected);
    expect(refund.attempts).toBe(3);
    expect(refund.nextAttemptAt).toBeUndefined();
  });

  it('gives up with REFERENCE_NOT_PROCESSED when the reference exists but is still waiting', () => {
    const wallet = openWallet('100.00');
    const win = newTransaction(Kind.Win, {
      externalTransactionId: 'win-1',
      referenceExternalTransactionId: 'bet-1',
    });
    win.markPendingReference({ observedBalance: brl('100.00'), nextAttemptAt: LATER });
    const rollback = newTransaction(Kind.Rollback, { referenceExternalTransactionId: 'win-1' });

    expectRejected(rollback, wallet, FailureCode.ReferenceNotProcessed, () =>
      run(rollback, wallet, { reference: win, missingReference: { action: 'reject' } }),
    );
    expect(rollback.attempts).toBe(1);
  });

  it('does not count an attempt for rejections unrelated to a missing reference', () => {
    const wallet = openWallet('100.00');
    const bet = processedTransaction(Kind.Bet, {
      externalTransactionId: 'bet-x',
      money: brl('10.00'),
    });
    const refund = newTransaction(Kind.Refund, { referenceExternalTransactionId: 'bet-x' });

    run(refund, wallet, { reference: bet, missingReference: { action: 'reject' } });

    expect(refund.failureCode).toBe(FailureCode.ReferenceAmountMismatch);
    expect(refund.attempts).toBe(0);
  });

  it('resolves a retried transaction once the reference arrives', () => {
    const wallet = openWallet('75.00');
    const bet = processedTransaction(Kind.Bet, { externalTransactionId: 'bet-late' });
    const refund = newTransaction(Kind.Refund, { referenceExternalTransactionId: 'bet-late' });

    run(refund, wallet);
    expect(refund.status).toBe(Status.PendingReference);

    run(refund, wallet, { reference: bet });
    expect(refund.status).toBe(Status.Processed);
    expect(wallet.balance.equals(brl('100.00'))).toBe(true);
  });
});
