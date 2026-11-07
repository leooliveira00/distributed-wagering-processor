/**
 * Helpers shared by the demo scripts. They talk to a running stack (`docker compose up`) through
 * its public interfaces only: the HTTP API and the SQS queues.
 */
import { type SQSClient } from '@aws-sdk/client-sqs';
import { type WagerSubmissionResult } from '../../src/application/wagering/wager-views';
import { type LedgerPageView, type WalletView } from '../../src/application/wallets/wallet-views';
import { type Env, loadEnv } from '../../src/infrastructure/config/env';
import { createSqsClient } from '../../src/infrastructure/messaging/sqs/sqs-client';

/** Comma-separated API base URLs; the cluster profile exposes 3000, 3001 and 3002. */
export const apiUrls = (process.env.DEMO_API_URLS ?? 'http://localhost:3000')
  .split(',')
  .map((url) => url.trim())
  .filter((url) => url.length > 0);

export const providerId = 'provider-demo';

/** Env for SQS access. Never real AWS by accident: the emulator unless an endpoint is set. */
export function demoEnv(): Env {
  const env = loadEnv();
  return { ...env, AWS_ENDPOINT_URL: env.AWS_ENDPOINT_URL ?? 'http://localhost:4566' };
}

export function demoSqs(env: Env): SQSClient {
  return createSqsClient(env);
}

interface CallOptions {
  method?: 'GET' | 'POST';
  headers?: Record<string, string>;
  body?: unknown;
}

async function call(
  url: string,
  options: CallOptions = {},
): Promise<{ status: number; body: unknown }> {
  const response = await fetch(url, {
    method: options.method ?? 'GET',
    headers: { 'content-type': 'application/json', ...options.headers },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    signal: AbortSignal.timeout(30_000),
  });
  return { status: response.status, body: await response.json() };
}

export async function createWallet(baseUrl: string, amount: string): Promise<WalletView> {
  const { status, body } = await call(`${baseUrl}/wallets`, {
    method: 'POST',
    body: { playerId: crypto.randomUUID(), initialBalance: { amount, currency: 'BRL' } },
  });
  if (status !== 201) throw new Error(`wallet creation failed with ${String(status)}`);
  return body as WalletView;
}

export interface Operation {
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: 'BET' | 'WIN' | 'LOSS' | 'REFUND' | 'ROLLBACK';
  money: { amount: string; currency: string };
  referenceExternalTransactionId?: string;
}

export function operation(
  wallet: WalletView,
  kind: Operation['kind'],
  amount: string,
  externalTransactionId = `demo-${crypto.randomUUID().slice(0, 8)}`,
): Operation {
  return {
    providerId,
    externalTransactionId,
    playerId: wallet.playerId,
    walletId: wallet.id,
    roundId: 'round-demo',
    gameId: 'fortune-chimp',
    kind,
    money: { amount, currency: 'BRL' },
  };
}

export const idempotencyKeyOf = (op: Operation) => `${op.providerId}:${op.externalTransactionId}`;

export async function submit(
  baseUrl: string,
  op: Operation,
): Promise<{ status: number; body: WagerSubmissionResult }> {
  const { status, body } = await call(`${baseUrl}/wagering/transactions`, {
    method: 'POST',
    headers: { 'idempotency-key': idempotencyKeyOf(op) },
    body: op,
  });
  return { status, body: body as WagerSubmissionResult };
}

export async function getWallet(baseUrl: string, walletId: string): Promise<WalletView> {
  return (await call(`${baseUrl}/wallets/${walletId}`)).body as WalletView;
}

export async function getLedger(baseUrl: string, walletId: string): Promise<LedgerPageView> {
  return (await call(`${baseUrl}/wallets/${walletId}/ledger?limit=100`)).body as LedgerPageView;
}

export async function reconcile(baseUrl: string, walletId: string): Promise<boolean> {
  const { body } = await call(`${baseUrl}/wallets/${walletId}/reconciliation`, {
    method: 'POST',
  });
  return (body as { consistent: boolean }).consistent;
}

/** Prints the ledger as a small table: direction, amount and balance after each entry. */
export async function printLedger(baseUrl: string, walletId: string): Promise<void> {
  const { items } = await getLedger(baseUrl, walletId);
  console.table(
    items.map((entry) => ({
      version: entry.walletVersion,
      direction: entry.direction,
      amount: entry.money.amount,
      before: entry.balanceBefore.amount,
      after: entry.balanceAfter.amount,
    })),
  );
}
