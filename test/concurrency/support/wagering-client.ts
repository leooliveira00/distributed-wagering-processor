import { type WagerSubmissionResult } from '../../../src/application/wagering/wager-views';
import { type WalletView } from '../../../src/application/wallets/wallet-views';

export interface SubmitResponse {
  status: number;
  body: WagerSubmissionResult;
}

/** Minimal HTTP client over any base URL (an in-process test app or a spawned instance). */
export async function openWallet(baseUrl: string, amount: string): Promise<WalletView> {
  const response = await fetch(`${baseUrl}/wallets`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      playerId: crypto.randomUUID(),
      initialBalance: { amount, currency: 'BRL' },
    }),
  });
  if (response.status !== 201)
    throw new Error(`wallet creation failed: ${String(response.status)}`);
  return (await response.json()) as WalletView;
}

export function bet(
  wallet: WalletView,
  amount: string,
  externalTransactionId = `tx-${crypto.randomUUID()}`,
) {
  return {
    providerId: 'provider-a',
    externalTransactionId,
    playerId: wallet.playerId,
    walletId: wallet.id,
    roundId: 'round-1',
    gameId: 'fortune-chimp',
    kind: 'BET',
    money: { amount, currency: 'BRL' },
  };
}

export async function submit(
  baseUrl: string,
  body: ReturnType<typeof bet>,
): Promise<SubmitResponse> {
  const response = await fetch(`${baseUrl}/wagering/transactions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'idempotency-key': `${body.providerId}:${body.externalTransactionId}`,
    },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as WagerSubmissionResult };
}
