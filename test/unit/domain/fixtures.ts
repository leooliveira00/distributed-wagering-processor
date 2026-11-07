import { Money } from '../../../src/domain/money/money';
import {
  type CreateWagerTransactionProps,
  WagerTransaction,
} from '../../../src/domain/wagering/wager-transaction';
import { WagerTransactionKind } from '../../../src/domain/wagering/wager-transaction-kind';
import { Wallet } from '../../../src/domain/wallet/wallet';

export const AT = new Date('2026-11-05T12:00:00.000Z');
export const LATER = new Date('2026-11-05T12:00:05.000Z');
export const HASH = 'a'.repeat(64);

export const WALLET_ID = 'wallet-1';
export const PLAYER_ID = 'player-1';
export const PROVIDER_ID = 'provider-a';
export const ROUND_ID = 'round-1';

export const brl = (amount: string): Money => Money.from({ amount, currency: 'BRL' });
export const usd = (amount: string): Money => Money.from({ amount, currency: 'USD' });

let sequence = 0;
export const nextId = (prefix: string): string => `${prefix}-${String(++sequence)}`;

export function openWallet(balance = '100.00', currency = 'BRL'): Wallet {
  return Wallet.open({
    id: WALLET_ID,
    playerId: PLAYER_ID,
    initialBalance: Money.from({ amount: balance, currency }),
    openingTransactionId: nextId('opening'),
    openingEntryId: nextId('entry'),
    at: AT,
  }).wallet;
}

export function newTransaction(
  kind: WagerTransactionKind,
  overrides: Partial<CreateWagerTransactionProps> = {},
): WagerTransaction {
  const externalTransactionId = overrides.externalTransactionId ?? nextId('ext');
  return WagerTransaction.create({
    id: nextId('tx'),
    providerId: PROVIDER_ID,
    externalTransactionId,
    idempotencyKey: `${overrides.providerId ?? PROVIDER_ID}:${externalTransactionId}`,
    payloadHash: HASH,
    walletId: WALLET_ID,
    playerId: PLAYER_ID,
    roundId: ROUND_ID,
    gameId: 'fortune-chimp',
    kind,
    money: brl('25.00'),
    createdAt: AT,
    ...overrides,
  });
}

/** A transaction already applied, usable as a reference. */
export function processedTransaction(
  kind: WagerTransactionKind,
  overrides: Partial<CreateWagerTransactionProps> = {},
): WagerTransaction {
  const transaction = newTransaction(kind, overrides);
  transaction.markProcessed({
    referenceTransactionId: undefined,
    observedBalance: brl('100.00'),
    at: AT,
  });
  return transaction;
}

export function referencing(
  kind: WagerTransactionKind,
  reference: WagerTransaction,
  overrides: Partial<CreateWagerTransactionProps> = {},
): WagerTransaction {
  return newTransaction(kind, {
    money: reference.money,
    referenceExternalTransactionId: reference.externalTransactionId,
    ...overrides,
  });
}

export { WagerTransactionKind as Kind };
