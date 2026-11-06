import { FailureCode } from '../shared/failure-code';
import { LedgerDirection } from '../wallet/ledger-direction';
import { type Wallet } from '../wallet/wallet';
import { type WalletLedgerEntry } from '../wallet/wallet-ledger-entry';
import { type WagerTransaction } from './wager-transaction';
import { WagerTransactionKind } from './wager-transaction-kind';
import { WagerTransactionStatus } from './wager-transaction-status';

/** What to do when the referenced transaction has not arrived (rule 7.8 / 7.1). */
export type MissingReferencePolicy =
  { action: 'retry'; nextAttemptAt: Date } | { action: 'reject' };

export interface ProcessWagerInput {
  /** PENDING (new) or PENDING_REFERENCE (retry). */
  transaction: WagerTransaction;
  /** Must already be locked by the caller. */
  wallet: Wallet;
  /** Resolved by (providerId, referenceExternalTransactionId); undefined when not found. */
  reference: WagerTransaction | undefined;
  /** Whether a PROCESSED REFUND/ROLLBACK already targets the reference. */
  referenceAlreadyReversed: boolean;
  missingReference: MissingReferencePolicy;
  ledgerEntryId: string;
  at: Date;
}

export type ProcessWagerOutcome =
  | { status: WagerTransactionStatus.Processed; ledgerEntry: WalletLedgerEntry | undefined }
  | { status: WagerTransactionStatus.Rejected; failureCode: FailureCode }
  | { status: WagerTransactionStatus.PendingReference };

/**
 * Applies the business rules of README §7 to one transaction against its (locked) wallet.
 * Pure domain logic: it mutates the given aggregates and returns the outcome; the caller
 * persists transaction, wallet, ledger entry and events in a single SQL transaction.
 *
 * Evaluation order: context (player, currency) -> reference resolution -> balance effect.
 */
export class WagerTransactionProcessor {
  process(input: ProcessWagerInput): ProcessWagerOutcome {
    const { transaction, wallet } = input;
    if (transaction.walletId !== wallet.id) {
      throw new Error(`Transaction ${transaction.id} does not belong to wallet ${wallet.id}`);
    }

    const contextFailure = this.checkWalletContext(transaction, wallet);
    if (contextFailure) return this.reject(input, contextFailure);

    if (transaction.referenceExternalTransactionId !== undefined) {
      const resolution = this.resolveReference(input);
      if (resolution.kind === 'pending') return this.pending(input);
      if (resolution.kind === 'exhausted') return this.giveUp(input, resolution.failureCode);
      if (resolution.kind === 'rejected') return this.reject(input, resolution.failureCode);
    }

    return this.apply(input);
  }

  private checkWalletContext(
    transaction: WagerTransaction,
    wallet: Wallet,
  ): FailureCode | undefined {
    if (transaction.playerId !== wallet.playerId) return FailureCode.PlayerWalletMismatch;
    if (transaction.money.currency !== wallet.currency) return FailureCode.CurrencyMismatch;
    return undefined;
  }

  private resolveReference(
    input: ProcessWagerInput,
  ):
    | { kind: 'resolved' }
    | { kind: 'pending' }
    | { kind: 'exhausted'; failureCode: FailureCode }
    | { kind: 'rejected'; failureCode: FailureCode } {
    const { transaction, reference, missingReference } = input;

    if (!reference) {
      return missingReference.action === 'retry'
        ? { kind: 'pending' }
        : { kind: 'exhausted', failureCode: FailureCode.ReferenceNotFound };
    }
    // A reference that is itself still waiting may resolve later: keep waiting with it.
    if (!reference.isTerminal()) {
      return missingReference.action === 'retry'
        ? { kind: 'pending' }
        : { kind: 'exhausted', failureCode: FailureCode.ReferenceNotProcessed };
    }
    if (reference.status !== WagerTransactionStatus.Processed) {
      return { kind: 'rejected', failureCode: FailureCode.ReferenceNotProcessed };
    }
    if (!transaction.canReference(reference)) {
      return { kind: 'rejected', failureCode: FailureCode.ReferenceKindNotAllowed };
    }
    if (
      reference.providerId !== transaction.providerId ||
      reference.playerId !== transaction.playerId ||
      reference.walletId !== transaction.walletId ||
      reference.money.currency !== transaction.money.currency ||
      reference.roundId !== transaction.roundId
    ) {
      return { kind: 'rejected', failureCode: FailureCode.ReferenceContextMismatch };
    }
    if (transaction.requiresReference()) {
      if (!reference.money.equals(transaction.money)) {
        return { kind: 'rejected', failureCode: FailureCode.ReferenceAmountMismatch };
      }
      // D6: a reference is reversed at most once in total, by REFUND or ROLLBACK.
      if (input.referenceAlreadyReversed) {
        return { kind: 'rejected', failureCode: FailureCode.ReferenceAlreadyReversed };
      }
    }
    return { kind: 'resolved' };
  }

  private apply(input: ProcessWagerInput): ProcessWagerOutcome {
    const { transaction, wallet, reference, at } = input;

    let ledgerEntry: WalletLedgerEntry | undefined;
    if (transaction.affectsBalance()) {
      const movement = { transactionId: transaction.id, entryId: input.ledgerEntryId, at };
      const direction = transaction.ledgerDirectionFor(reference);

      if (direction === LedgerDirection.Debit) {
        if (!wallet.canDebit(transaction.money)) {
          return this.reject(
            input,
            transaction.kind === WagerTransactionKind.Bet
              ? FailureCode.InsufficientFunds
              : FailureCode.ReversalInsufficientFunds,
          );
        }
        ledgerEntry = wallet.debit(transaction.money, movement);
      } else {
        ledgerEntry = wallet.credit(transaction.money, movement);
      }
    }

    transaction.markProcessed({
      referenceTransactionId: reference?.id,
      observedBalance: wallet.balance,
      at,
    });
    return { status: WagerTransactionStatus.Processed, ledgerEntry };
  }

  private reject(input: ProcessWagerInput, failureCode: FailureCode): ProcessWagerOutcome {
    input.transaction.reject(failureCode, { observedBalance: input.wallet.balance });
    return { status: WagerTransactionStatus.Rejected, failureCode };
  }

  /** The last attempt found the reference still not ready: counted, then rejected. */
  private giveUp(input: ProcessWagerInput, failureCode: FailureCode): ProcessWagerOutcome {
    input.transaction.giveUpOnReference(failureCode, { observedBalance: input.wallet.balance });
    return { status: WagerTransactionStatus.Rejected, failureCode };
  }

  private pending(input: ProcessWagerInput): ProcessWagerOutcome {
    if (input.missingReference.action !== 'retry') {
      throw new Error('pending outcome requires a retry policy');
    }
    input.transaction.markPendingReference({
      observedBalance: input.wallet.balance,
      nextAttemptAt: input.missingReference.nextAttemptAt,
    });
    return { status: WagerTransactionStatus.PendingReference };
  }
}
