import { backoffDelayMs } from '../../domain/shared/backoff';
import { type FailureCode } from '../../domain/shared/failure-code';
import { type WagerTransaction } from '../../domain/wagering/wager-transaction';
import { WagerTransactionStatus } from '../../domain/wagering/wager-transaction-status';
import { TransientError } from '../errors';
import { type FaultInjector } from '../ports/fault-injector';
import { type AppLogger } from '../ports/logger';
import { type Metrics } from '../ports/metrics';
import { type Clock, type IdGenerator } from '../ports/system';
import { type TransactionScope, type UnitOfWork } from '../ports/unit-of-work';
import { type OnMissingReference, WagerTransactionApplier } from './wager-transaction-applier';
import { type PendingReferencePolicy } from './wager-command';

export interface ResolvePendingReferencesOptions {
  /** Most transactions attempted per pass; each one is its own SQL transaction. */
  batchSize: number;
}

/** processed/rejected are terminal; rescheduled keeps waiting; failed was deferred after an error. */
export type PendingAttemptOutcome = 'processed' | 'rejected' | 'rescheduled' | 'failed';

export type ResolvePendingReferencesResult = Record<PendingAttemptOutcome, number> & {
  attempted: number;
};

interface CommittedAttempt {
  transaction: WagerTransaction;
  outcome: Exclude<PendingAttemptOutcome, 'failed'>;
  failureCode: FailureCode | undefined;
  correlationId: string;
}

/**
 * Pending-reference worker (README §7.1, §13 concurrency 7): re-evaluates PENDING_REFERENCE
 * transactions whose retry is due, until the reference arrives or the attempts run out.
 *
 * Each attempt is ONE SQL transaction, and all its work is in the database:
 *  1. lock the most overdue pending row with FOR UPDATE SKIP LOCKED (other instances skip it);
 *  2. lock its wallet with FOR UPDATE, exactly like a submission;
 *  3. look the reference up AFTER the wallet lock, so a reference committed by a concurrent
 *     submission on that wallet is always seen;
 *  4. apply the same rules as a submission (WagerTransactionApplier) and commit.
 * A crash or error rolls everything back and releases the row lock: the transaction is simply
 * pending again. Unlike the outbox there is no network call inside, so no lease is needed.
 *
 * Lock order is pending row -> wallet. Submissions lock wallet -> (never waits on pending rows:
 * expediteDependents uses SKIP LOCKED), so the two paths cannot deadlock.
 *
 * Attempts (D11): the submission is attempt 1; attempt `maxAttempts` is the last one. Then a
 * missing reference is REJECTED with REFERENCE_NOT_FOUND, or REFERENCE_NOT_PROCESSED when the
 * reference exists but never got processed, and WagerTransactionRejected is published.
 */
export class ResolvePendingReferences {
  private readonly applier: WagerTransactionApplier;

  constructor(
    private readonly unitOfWork: UnitOfWork,
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
    private readonly policy: PendingReferencePolicy,
    private readonly metrics: Metrics,
    private readonly logger: AppLogger,
    private readonly faults: FaultInjector,
    private readonly options: ResolvePendingReferencesOptions,
  ) {
    this.applier = new WagerTransactionApplier(ids);
  }

  /** One pass: attempts due transactions until none is left or the batch is full. */
  async runOnce(): Promise<ResolvePendingReferencesResult> {
    const result: ResolvePendingReferencesResult = {
      attempted: 0,
      processed: 0,
      rejected: 0,
      rescheduled: 0,
      failed: 0,
    };
    while (result.attempted < this.options.batchSize) {
      const outcome = await this.attemptNext();
      if (outcome === undefined) break;
      result.attempted++;
      result[outcome]++;
    }
    return result;
  }

  /** One log scope per attempt: every line it writes carries the transaction it works on. */
  private attemptNext(): Promise<PendingAttemptOutcome | undefined> {
    // No request started this attempt: a new correlation id, caused by the waiting transaction.
    const correlationId = this.ids.next();
    return this.logger.withContext({ correlationId }, () => this.attemptInScope(correlationId));
  }

  private async attemptInScope(correlationId: string): Promise<PendingAttemptOutcome | undefined> {
    // Object holder: the compiler does not track assignments made inside the callback.
    const claim: { transaction?: WagerTransaction } = {};
    let committed: CommittedAttempt | undefined;
    try {
      committed = await this.unitOfWork.run(async (scope) => {
        const transaction = await scope.transactions.lockNextDuePending(await scope.databaseNow());
        if (!transaction) return undefined;
        claim.transaction = transaction;
        this.logger.addContext({
          transactionId: transaction.id,
          walletId: transaction.walletId,
          providerId: transaction.providerId,
        });
        const attempt = await this.attempt(scope, transaction, correlationId);
        // Test-only crash point: dying here must roll the whole attempt back.
        this.faults.trigger('pending:before-commit');
        return attempt;
      });
    } catch (error) {
      // Nothing claimed: the database itself is failing. Let the polling loop back off.
      if (!claim.transaction) throw error;
      await this.defer(claim.transaction, error);
      return 'failed';
    }
    if (!committed) return undefined;
    this.report(committed);
    return committed.outcome;
  }

  private async attempt(
    scope: TransactionScope,
    transaction: WagerTransaction,
    correlationId: string,
  ): Promise<CommittedAttempt> {
    const wallet = await scope.wallets.findByIdForUpdate(transaction.walletId);
    // The foreign key makes this impossible; fail loudly rather than guess.
    if (!wallet) {
      throw new Error(`Wallet ${transaction.walletId} of transaction ${transaction.id} not found`);
    }

    const attempt = transaction.attempts + 1;
    const onMissingReference: OnMissingReference =
      attempt >= this.policy.maxAttempts
        ? { action: 'reject' }
        : { action: 'retry', delayMs: backoffDelayMs(attempt, this.policy.backoff) };
    const at = this.clock.now();

    const outcome = await this.applier.apply(scope, {
      transaction,
      wallet,
      isNew: false,
      onMissingReference,
      at,
      eventContext: () => ({
        eventId: this.ids.next(),
        correlationId,
        causationId: transaction.id,
        occurredAt: at,
      }),
    });

    return {
      transaction,
      outcome:
        outcome.status === WagerTransactionStatus.Processed
          ? 'processed'
          : outcome.status === WagerTransactionStatus.Rejected
            ? 'rejected'
            : 'rescheduled',
      failureCode:
        outcome.status === WagerTransactionStatus.Rejected ? outcome.failureCode : undefined,
      correlationId,
    };
  }

  /** Metrics and logs only after the commit, so a rolled-back attempt is never reported. */
  private report({ transaction, outcome, failureCode, correlationId }: CommittedAttempt): void {
    this.metrics.increment('pending_reference_attempts_total', { outcome });
    const fields = {
      transactionId: transaction.id,
      providerId: transaction.providerId,
      externalTransactionId: transaction.externalTransactionId,
      referenceExternalTransactionId: transaction.referenceExternalTransactionId,
      attempts: transaction.attempts,
      correlationId,
    };
    if (outcome === 'rescheduled') {
      this.logger.info('Reference still missing, retry scheduled', {
        ...fields,
        nextAttemptAt: transaction.nextAttemptAt?.toISOString(),
      });
    } else if (outcome === 'rejected') {
      this.logger.warn('Pending transaction rejected', { ...fields, failureCode });
    } else {
      this.logger.info('Pending transaction processed', fields);
    }
  }

  /**
   * An attempt that failed unexpectedly (lock timeout on a hot wallet, a bug, bad data) is
   * pushed back with the same backoff, without counting as a reference attempt. Otherwise the
   * most overdue row would be picked again immediately and block every row behind it.
   */
  private async defer(transaction: WagerTransaction, error: unknown): Promise<void> {
    const delayMs = backoffDelayMs(transaction.attempts + 1, this.policy.backoff);
    this.metrics.increment('pending_reference_failures_total');
    const fields = {
      transactionId: transaction.id,
      attempts: transaction.attempts,
      delayMs,
      error: error instanceof Error ? error.message : String(error),
    };
    // A lock timeout on a hot wallet is expected under load; anything else is a defect.
    if (error instanceof TransientError) {
      this.logger.warn('Pending reference attempt failed, deferred', fields);
    } else {
      this.logger.error('Pending reference attempt failed, deferred', fields);
    }
    await this.unitOfWork.run((scope) => scope.transactions.deferPending(transaction.id, delayMs));
  }
}
