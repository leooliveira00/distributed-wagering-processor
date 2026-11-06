import { WagerTransactionPendingReference } from '../../domain/messaging/events/wager-transaction-pending-reference';
import { WagerTransactionProcessed } from '../../domain/messaging/events/wager-transaction-processed';
import { WagerTransactionRejected } from '../../domain/messaging/events/wager-transaction-rejected';
import { WalletBalanceChanged } from '../../domain/messaging/events/wallet-balance-changed';
import { type EventContext, type IntegrationEvent } from '../../domain/messaging/integration-event';
import { OutboxMessage } from '../../domain/messaging/outbox-message';
import { type WagerTransaction } from '../../domain/wagering/wager-transaction';
import {
  type MissingReferencePolicy,
  type ProcessWagerOutcome,
  WagerTransactionProcessor,
} from '../../domain/wagering/wager-transaction-processor';
import { WagerTransactionStatus } from '../../domain/wagering/wager-transaction-status';
import { type Wallet } from '../../domain/wallet/wallet';
import { type IdGenerator } from '../ports/system';
import { type TransactionScope } from '../ports/unit-of-work';

/** What to do if the reference is still missing: wait `delayMs` more, or give up now. */
export type OnMissingReference = { action: 'retry'; delayMs: number } | { action: 'reject' };

export interface ApplyWagerInput {
  transaction: WagerTransaction;
  /** Must already be locked (SELECT ... FOR UPDATE) in this unit of work. */
  wallet: Wallet;
  /** A new submission is inserted; a pending one, loaded in this unit of work, is updated. */
  isNew: boolean;
  onMissingReference: OnMissingReference;
  /** Business timestamp (processedAt, event occurredAt). Schedules use the database clock. */
  at: Date;
  eventContext: () => EventContext;
}

/**
 * The part of processing shared by the submission (HTTP/SQS) and the pending-reference worker,
 * so a transaction is decided by the same rules whether it is applied on arrival or later:
 * reference resolution, domain rules, persistence of transaction/wallet/ledger, outbox events
 * and the expediting of dependents. Runs inside the caller's unit of work and wallet lock.
 */
export class WagerTransactionApplier {
  private readonly processor = new WagerTransactionProcessor();

  constructor(private readonly ids: IdGenerator) {}

  async apply(scope: TransactionScope, input: ApplyWagerInput): Promise<ProcessWagerOutcome> {
    const { transaction, wallet } = input;

    const reference =
      transaction.referenceExternalTransactionId === undefined
        ? undefined
        : await scope.transactions.findByExternalId(
            transaction.providerId,
            transaction.referenceExternalTransactionId,
          );
    const referenceAlreadyReversed =
      reference !== undefined && transaction.requiresReference()
        ? await scope.transactions.hasProcessedReversal(reference.id)
        : false;

    const outcome = this.processor.process({
      transaction,
      wallet,
      reference,
      referenceAlreadyReversed,
      missingReference: await this.missingReferencePolicy(scope, input),
      ledgerEntryId: this.ids.next(),
      at: input.at,
    });

    if (input.isNew) scope.transactions.add(transaction);
    else scope.transactions.save(transaction);
    if (outcome.status === WagerTransactionStatus.Processed && outcome.ledgerEntry) {
      scope.wallets.save(wallet);
      scope.ledger.add(outcome.ledgerEntry);
    }
    for (const event of this.eventsFor(transaction, wallet, outcome, input)) {
      scope.outbox.add(OutboxMessage.enqueue(event));
    }
    // A terminal transaction decides whatever was waiting for it: re-evaluate those right away.
    if (transaction.isTerminal()) {
      await scope.transactions.expediteDependents(
        transaction.providerId,
        transaction.externalTransactionId,
      );
    }
    return outcome;
  }

  /**
   * The next attempt is scheduled on the database clock, the one the worker compares against
   * (`next_attempt_at <= now()`). Only transactions with a reference can wait, so only those pay
   * for reading it.
   */
  private async missingReferencePolicy(
    scope: TransactionScope,
    input: ApplyWagerInput,
  ): Promise<MissingReferencePolicy> {
    const policy = input.onMissingReference;
    if (
      policy.action === 'reject' ||
      input.transaction.referenceExternalTransactionId === undefined
    ) {
      return { action: 'reject' };
    }
    const now = await scope.databaseNow();
    return { action: 'retry', nextAttemptAt: new Date(now.getTime() + policy.delayMs) };
  }

  /**
   * Events are emitted once per state the provider cares about: PENDING_REFERENCE on arrival,
   * then the terminal outcome. A retry that keeps waiting publishes nothing.
   */
  private eventsFor(
    transaction: WagerTransaction,
    wallet: Wallet,
    outcome: ProcessWagerOutcome,
    input: ApplyWagerInput,
  ): IntegrationEvent<unknown>[] {
    switch (outcome.status) {
      case WagerTransactionStatus.Processed:
        return [
          WagerTransactionProcessed.from(transaction, input.eventContext()),
          ...(outcome.ledgerEntry
            ? [WalletBalanceChanged.from(wallet, outcome.ledgerEntry, input.eventContext())]
            : []),
        ];
      case WagerTransactionStatus.Rejected:
        return [WagerTransactionRejected.from(transaction, input.eventContext())];
      case WagerTransactionStatus.PendingReference:
        return input.isNew
          ? [WagerTransactionPendingReference.from(transaction, input.eventContext())]
          : [];
    }
  }
}
