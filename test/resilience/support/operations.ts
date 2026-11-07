import { expect } from 'bun:test';
import { type WalletView } from '../../../src/application/wallets/wallet-views';
import { bet } from '../../concurrency/support/wagering-client';
import { type TestDatabase } from '../../integration/support/test-database';
import { type TestQueue } from '../../integration/support/test-queue';

export type Operation = ReturnType<typeof bet> & { referenceExternalTransactionId?: string };

const idempotencyKeyOf = (operation: Operation) =>
  `${operation.providerId}:${operation.externalTransactionId}`;

/** A ROLLBACK of `betId`, possibly sent before that BET exists. */
export const rollbackOf = (wallet: WalletView, betId: string): Operation => ({
  ...bet(wallet, '1.00'),
  kind: 'ROLLBACK',
  referenceExternalTransactionId: betId,
});

/** POST /wagering/transactions, bounded so that a hanging server fails the test instead. */
export const postOperation = (baseUrl: string, operation: Operation) =>
  fetch(`${baseUrl}/wagering/transactions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'idempotency-key': idempotencyKeyOf(operation),
    },
    body: JSON.stringify(operation),
    signal: AbortSignal.timeout(30_000),
  });

/** Sends the operation as a `WagerTransactionRequested` message, grouped by wallet. */
export const enqueueOperation = (queue: TestQueue, operation: Operation) =>
  queue.send(
    {
      messageId: `msg-${operation.externalTransactionId}`,
      type: 'WagerTransactionRequested',
      occurredAt: new Date().toISOString(),
      data: { ...operation, idempotencyKey: idempotencyKeyOf(operation) },
    },
    { groupId: operation.walletId },
  );

export const statusOf = async (baseUrl: string, path: string) =>
  (await fetch(`${baseUrl}${path}`, { signal: AbortSignal.timeout(10_000) })).status;

export async function countRows(db: TestDatabase, sql: string, params: unknown[] = []) {
  const rows: { n: number }[] = await db.sql.unsafe(sql, params);
  return rows[0]?.n ?? 0;
}

export const unpublishedEvents = (db: TestDatabase) =>
  countRows(db, 'select count(*)::int as n from outbox_messages where published_at is null');

/** Exactly one PROCESSED transaction and exactly one ledger entry per external id. */
export async function expectAppliedOnce(db: TestDatabase, operation: Operation): Promise<void> {
  const params = [operation.providerId, operation.externalTransactionId];
  const transactions = await countRows(
    db,
    `select count(*)::int as n from wager_transactions
      where provider_id = $1 and external_transaction_id = $2 and status = 'PROCESSED'`,
    params,
  );
  const entries = await countRows(
    db,
    `select count(*)::int as n from wallet_ledger_entries e
       join wager_transactions t on t.id = e.transaction_id
      where t.provider_id = $1 and t.external_transaction_id = $2`,
    params,
  );
  expect({ id: operation.externalTransactionId, transactions, entries }).toEqual({
    id: operation.externalTransactionId,
    transactions: 1,
    entries: 1,
  });
}

/** POST /wallets/:id/reconciliation must report the wallet as consistent. */
export async function expectReconciled(baseUrl: string, walletId: string): Promise<void> {
  const response = await fetch(`${baseUrl}/wallets/${walletId}/reconciliation`, {
    method: 'POST',
  });
  expect(await response.json()).toMatchObject({ consistent: true });
}
