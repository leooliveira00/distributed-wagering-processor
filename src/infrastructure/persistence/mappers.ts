import { InboxMessage } from '../../domain/messaging/inbox-message';
import { OutboxMessage } from '../../domain/messaging/outbox-message';
import { Money } from '../../domain/money/money';
import { FailureCode } from '../../domain/shared/failure-code';
import { WagerTransaction } from '../../domain/wagering/wager-transaction';
import { WagerTransactionKind } from '../../domain/wagering/wager-transaction-kind';
import { WagerTransactionStatus } from '../../domain/wagering/wager-transaction-status';
import { LedgerDirection } from '../../domain/wallet/ledger-direction';
import { Wallet } from '../../domain/wallet/wallet';
import { WalletLedgerEntry } from '../../domain/wallet/wallet-ledger-entry';
import { type LedgerEntryRecord } from './records/ledger-entry.record';
import { type InboxMessageRecord, type OutboxMessageRecord } from './records/messaging.records';
import { type WagerTransactionRecord } from './records/wager-transaction.record';
import { type WalletRecord } from './records/wallet.record';

/**
 * Record <-> domain translation. Reads always go through the domain `rehydrate` factories, which
 * rebuild persisted state without re-running transition rules (README §6.0). Amounts stay exact:
 * numeric columns arrive as decimal strings and become `Money` directly.
 */

const money = (amount: string, currency: string): Money => Money.from({ amount, currency });

/** Validates a persisted value against its enum, so corrupted data fails loudly on read. */
function parseEnum<T extends string>(values: Record<string, T>, value: string, field: string): T {
  const match = Object.values(values).find((candidate) => candidate === value);
  if (match === undefined) throw new Error(`Unexpected ${field} value in database: ${value}`);
  return match;
}

// ---- wallet

export function toWallet(record: WalletRecord): Wallet {
  return Wallet.rehydrate({
    id: record.id,
    playerId: record.playerId,
    currency: record.currency,
    balance: money(record.balance, record.currency),
    version: record.version,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  });
}

export function walletRecordData(wallet: Wallet): WalletRecord {
  return {
    id: wallet.id,
    playerId: wallet.playerId,
    currency: wallet.currency,
    balance: wallet.balance.toJSON().amount,
    version: wallet.version,
    createdAt: wallet.createdAt,
    updatedAt: wallet.updatedAt,
  };
}

// ---- wager transaction

export function toWagerTransaction(record: WagerTransactionRecord): WagerTransaction {
  return WagerTransaction.rehydrate({
    id: record.id,
    providerId: record.providerId,
    externalTransactionId: record.externalTransactionId,
    idempotencyKey: record.idempotencyKey,
    payloadHash: record.payloadHash,
    walletId: record.wallet.id,
    playerId: record.playerId,
    roundId: record.roundId,
    gameId: record.gameId,
    kind: parseEnum(WagerTransactionKind, record.kind, 'kind'),
    money: money(record.amount, record.currency),
    referenceExternalTransactionId: record.referenceExternalTransactionId ?? undefined,
    createdAt: record.createdAt,
    status: parseEnum(WagerTransactionStatus, record.status, 'status'),
    referenceTransactionId: record.referenceTransaction?.id ?? undefined,
    failureCode:
      record.failureCode === null
        ? undefined
        : parseEnum(FailureCode, record.failureCode, 'failure_code'),
    processedAt: record.processedAt ?? undefined,
    observedBalance:
      record.observedBalance !== null && record.observedBalanceCurrency !== null
        ? money(record.observedBalance, record.observedBalanceCurrency)
        : undefined,
    attempts: record.attempts,
    nextAttemptAt: record.nextAttemptAt ?? undefined,
  });
}

/** Mutable lifecycle fields, applied on insert and on every save. */
export function wagerTransactionStateData(
  transaction: WagerTransaction,
): Pick<
  WagerTransactionRecord,
  | 'status'
  | 'failureCode'
  | 'observedBalance'
  | 'observedBalanceCurrency'
  | 'attempts'
  | 'nextAttemptAt'
  | 'processedAt'
> {
  const observed = transaction.observedBalance?.toJSON();
  return {
    status: transaction.status,
    failureCode: transaction.failureCode ?? null,
    observedBalance: observed?.amount ?? null,
    observedBalanceCurrency: observed?.currency ?? null,
    attempts: transaction.attempts,
    nextAttemptAt: transaction.nextAttemptAt ?? null,
    processedAt: transaction.processedAt ?? null,
  };
}

// ---- ledger

export function toLedgerEntry(record: LedgerEntryRecord): WalletLedgerEntry {
  return WalletLedgerEntry.rehydrate({
    id: record.id,
    walletId: record.wallet.id,
    transactionId: record.transaction.id,
    direction: parseEnum(LedgerDirection, record.direction, 'direction'),
    money: money(record.amount, record.currency),
    balanceBefore: money(record.balanceBefore, record.currency),
    balanceAfter: money(record.balanceAfter, record.currency),
    walletVersion: record.walletVersion,
    createdAt: record.createdAt,
  });
}

// ---- inbox / outbox

export function toInboxMessage(record: InboxMessageRecord): InboxMessage {
  return InboxMessage.rehydrate({
    consumerName: record.consumerName,
    messageId: record.messageId,
    payloadHash: record.payloadHash,
    receivedAt: record.receivedAt,
    processedAt: record.processedAt ?? undefined,
  });
}

export function toOutboxMessage(record: OutboxMessageRecord): OutboxMessage {
  return OutboxMessage.rehydrate({
    id: record.id,
    aggregateId: record.aggregateId,
    eventType: record.eventType,
    payload: record.payload,
    occurredAt: record.occurredAt,
    attempts: record.attempts,
    nextAttemptAt: record.nextAttemptAt ?? undefined,
    publishedAt: record.publishedAt ?? undefined,
  });
}
