import { InboxMessage } from '../../domain/messaging/inbox-message';
import { Money } from '../../domain/money/money';
import { backoffDelayMs } from '../../domain/shared/backoff';
import { DomainError } from '../../domain/shared/domain-error';
import { INTERNAL_PROVIDER_ID, WagerTransaction } from '../../domain/wagering/wager-transaction';
import {
  ApplicationError,
  ConflictError,
  InvalidRequestError,
  TransientError,
  UniqueViolationError,
} from '../errors';
import { type Metrics } from '../ports/metrics';
import { type Clock, type IdGenerator } from '../ports/system';
import { type TransactionScope, type UnitOfWork } from '../ports/unit-of-work';
import { payloadHash } from '../shared/canonical-json';
import { type RequestContext } from '../shared/request-context';
import { walletNotFound } from '../wallets/wallet-queries';
import {
  type InboxContext,
  type PendingReferencePolicy,
  type SubmitWagerCommand,
  wagerBusinessPayload,
} from './wager-command';
import { WagerTransactionApplier } from './wager-transaction-applier';
import { toSubmissionResult, type WagerSubmissionResult } from './wager-views';

/** Constraints whose violation means "a concurrent submission of the same thing won the race". */
const RACE_CONSTRAINTS = new Set([
  'wager_transactions_idempotency_uq',
  'wager_transactions_external_uq',
  'inbox_messages_pk',
]);

/** Conflicts caused by reusing an idempotency key or message id with another payload. */
const IDEMPOTENCY_CONFLICTS = new Set([
  'IDEMPOTENCY_KEY_CONFLICT',
  'MESSAGE_PAYLOAD_CONFLICT',
  'EXTERNAL_TRANSACTION_CONFLICT',
]);

type Entrypoint = 'http' | 'sqs';

/**
 * Applies a provider operation (BET, WIN, LOSS, REFUND, ROLLBACK). One use case for both entry
 * points: HTTP and the SQS consumer (README §10).
 *
 * Everything happens in a single SQL transaction (README §6.5, §11):
 *  1. message-level dedup through the inbox (queue entries only);
 *  2. row lock on the wallet (SELECT ... FOR UPDATE): the unit of concurrency (README §8);
 *  3. idempotency lookup AFTER the lock, so a concurrent duplicate on the same wallet waits and
 *     then sees the committed original (replay) instead of racing it;
 *  4. reference resolution and domain rules (WagerTransactionApplier, shared with the
 *     pending-reference worker);
 *  5. transaction, wallet, ledger entry, integration events and inbox written together.
 * A missing reference leaves the transaction PENDING_REFERENCE, first retry scheduled on the
 * database clock; ResolvePendingReferences takes it from there (README §7.1).
 * A duplicate that reaches the database anyway (same key, different wallet) is stopped by the
 * unique constraints and resolved by re-reading the winner.
 */
export class SubmitWagerTransaction {
  private readonly applier: WagerTransactionApplier;

  constructor(
    private readonly unitOfWork: UnitOfWork,
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
    private readonly pendingReference: PendingReferencePolicy,
    private readonly metrics: Metrics,
  ) {
    this.applier = new WagerTransactionApplier(ids);
  }

  async execute(
    command: SubmitWagerCommand,
    context: RequestContext,
    inbox?: InboxContext,
  ): Promise<WagerSubmissionResult> {
    // Queue entries always carry the inbox context; HTTP submissions never do.
    const entrypoint: Entrypoint = inbox ? 'sqs' : 'http';
    const started = performance.now();
    try {
      const result = await this.process(command, context, inbox);
      this.recordResult(command, result, entrypoint, started);
      return result;
    } catch (error) {
      this.recordFailure(error, entrypoint, started);
      throw error;
    }
  }

  private async process(
    command: SubmitWagerCommand,
    context: RequestContext,
    inbox: InboxContext | undefined,
  ): Promise<WagerSubmissionResult> {
    if (command.providerId === INTERNAL_PROVIDER_ID) {
      throw new InvalidRequestError(
        'providerId "internal" is reserved',
        [{ path: 'providerId', message: 'Reserved for internal transactions' }],
        'RESERVED_PROVIDER',
      );
    }
    const hash = payloadHash(wagerBusinessPayload(command));
    const at = this.clock.now();
    // Contract checks (money format, kind, reference rules) fail here, before any database work.
    const transaction = WagerTransaction.create({
      id: this.ids.next(),
      providerId: command.providerId,
      externalTransactionId: command.externalTransactionId,
      idempotencyKey: command.idempotencyKey,
      payloadHash: hash,
      walletId: command.walletId,
      playerId: command.playerId,
      roundId: command.roundId,
      gameId: command.gameId,
      kind: command.kind,
      money: Money.from(command.money),
      referenceExternalTransactionId: command.referenceExternalTransactionId,
      createdAt: at,
    });

    try {
      return await this.unitOfWork.run((scope) =>
        this.submit(scope, transaction, { hash, at, context, inbox }),
      );
    } catch (error) {
      if (error instanceof UniqueViolationError && RACE_CONSTRAINTS.has(error.constraint ?? '')) {
        return this.resolveRace(command, hash);
      }
      throw error;
    }
  }

  private async submit(
    scope: TransactionScope,
    transaction: WagerTransaction,
    input: { hash: string; at: Date; context: RequestContext; inbox: InboxContext | undefined },
  ): Promise<WagerSubmissionResult> {
    const { hash, at, context, inbox } = input;

    if (inbox) {
      const seen = await scope.inbox.find(inbox.consumerName, inbox.messageId);
      if (seen) {
        if (!seen.matchesPayload(hash)) {
          throw new ConflictError(
            'MESSAGE_PAYLOAD_CONFLICT',
            `Message ${inbox.messageId} was already received with a different payload`,
          );
        }
        const original = await scope.transactions.findByIdempotencyKey(
          transaction.providerId,
          transaction.idempotencyKey,
        );
        if (original) return toSubmissionResult(original, true);
      }
    }

    const lockStarted = performance.now();
    const wallet = await scope.wallets.findByIdForUpdate(transaction.walletId);
    this.metrics.observe('wallet_lock_wait_seconds', seconds(lockStarted), {
      source: 'submission',
    });
    if (!wallet) throw walletNotFound(transaction.walletId);

    const existing = await scope.transactions.findByIdempotencyKey(
      transaction.providerId,
      transaction.idempotencyKey,
    );
    if (existing) {
      const replay = replayOrConflict(existing, hash);
      this.recordInbox(scope, inbox, hash, at);
      return replay;
    }

    const sameExternal = await scope.transactions.findByExternalId(
      transaction.providerId,
      transaction.externalTransactionId,
    );
    if (sameExternal) throw externalTransactionConflict(transaction);

    await this.applier.apply(scope, {
      transaction,
      wallet,
      isNew: true,
      // The submission is attempt 1; the worker makes the following ones (README §7.1, D11).
      onMissingReference: {
        action: 'retry',
        delayMs: backoffDelayMs(transaction.attempts + 1, this.pendingReference.backoff),
      },
      at,
      eventContext: () => ({
        eventId: this.ids.next(),
        correlationId: context.correlationId,
        causationId: inbox?.messageId ?? context.causationId,
        occurredAt: at,
      }),
    });
    this.recordInbox(scope, inbox, hash, at);
    return toSubmissionResult(transaction, false);
  }

  /** Re-reads the submission that won a unique-constraint race and answers as a replay. */
  private async resolveRace(
    command: SubmitWagerCommand,
    hash: string,
  ): Promise<WagerSubmissionResult> {
    return this.unitOfWork.run(
      async (scope) => {
        const winner = await scope.transactions.findByIdempotencyKey(
          command.providerId,
          command.idempotencyKey,
        );
        if (winner) return replayOrConflict(winner, hash);
        const sameExternal = await scope.transactions.findByExternalId(
          command.providerId,
          command.externalTransactionId,
        );
        if (sameExternal) throw externalTransactionConflict(command);
        // The constraint fired but the winner is not visible yet: let the caller retry.
        throw new TransientError('Concurrent submission in progress, retry later');
      },
      { readOnly: true },
    );
  }

  /** After the commit (or the replay read): only what really happened is counted. */
  private recordResult(
    command: SubmitWagerCommand,
    result: WagerSubmissionResult,
    entrypoint: Entrypoint,
    started: number,
  ): void {
    if (result.idempotentReplay) {
      this.metrics.increment('wager_idempotent_replays_total', { entrypoint });
    } else {
      this.metrics.increment('wager_transactions_total', {
        kind: command.kind,
        status: result.status,
        source: 'submission',
      });
    }
    this.metrics.observe('wager_processing_duration_seconds', seconds(started), {
      entrypoint,
      outcome: result.idempotentReplay ? 'replay' : result.status.toLowerCase(),
    });
  }

  private recordFailure(error: unknown, entrypoint: Entrypoint, started: number): void {
    if (error instanceof ConflictError && IDEMPOTENCY_CONFLICTS.has(error.code)) {
      this.metrics.increment('wager_idempotency_conflicts_total', { entrypoint, code: error.code });
    }
    const outcome =
      error instanceof ApplicationError
        ? error.kind
        : error instanceof DomainError
          ? 'invalid'
          : 'error';
    this.metrics.observe('wager_processing_duration_seconds', seconds(started), {
      entrypoint,
      outcome,
    });
  }

  private recordInbox(
    scope: TransactionScope,
    inbox: InboxContext | undefined,
    hash: string,
    at: Date,
  ): void {
    if (!inbox) return;
    const message = InboxMessage.receive({ ...inbox, payloadHash: hash, receivedAt: at });
    message.markProcessed(at);
    scope.inbox.add(message);
  }
}

function seconds(since: number): number {
  return (performance.now() - since) / 1000;
}

function replayOrConflict(existing: WagerTransaction, hash: string): WagerSubmissionResult {
  if (!existing.matchesPayload(hash)) {
    throw new ConflictError(
      'IDEMPOTENCY_KEY_CONFLICT',
      'Idempotency key was already used with a different payload',
    );
  }
  return toSubmissionResult(existing, true);
}

function externalTransactionConflict(transaction: {
  providerId: string;
  externalTransactionId: string;
}): ConflictError {
  return new ConflictError(
    'EXTERNAL_TRANSACTION_CONFLICT',
    `Transaction ${transaction.externalTransactionId} of ${transaction.providerId} was already submitted with another idempotency key`,
  );
}
