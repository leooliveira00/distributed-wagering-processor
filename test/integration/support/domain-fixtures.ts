import { type TransactionScope } from '../../../src/application/ports/unit-of-work';
import { Money } from '../../../src/domain/money/money';
import {
  type CreateWagerTransactionProps,
  WagerTransaction,
} from '../../../src/domain/wagering/wager-transaction';
import { WagerTransactionKind } from '../../../src/domain/wagering/wager-transaction-kind';
import { Wallet } from '../../../src/domain/wallet/wallet';

export const HASH = 'a'.repeat(64);
export const brl = (amount: string): Money => Money.from({ amount, currency: 'BRL' });
export const uuid = (): string => crypto.randomUUID();

/** Opens a wallet and registers it, its OPENING transaction and entry in the given scope. */
export function openWallet(scope: TransactionScope, balance = '100.00', currency = 'BRL'): Wallet {
  const at = new Date();
  const initialBalance = Money.from({ amount: balance, currency });
  const openingTransactionId = uuid();
  const { wallet, openingEntry } = Wallet.open({
    id: uuid(),
    playerId: uuid(),
    initialBalance,
    openingTransactionId,
    openingEntryId: uuid(),
    at,
  });
  scope.wallets.add(wallet);
  if (openingEntry) {
    scope.transactions.add(
      WagerTransaction.createOpening({
        id: openingTransactionId,
        walletId: wallet.id,
        playerId: wallet.playerId,
        money: initialBalance,
        payloadHash: HASH,
        at,
      }),
    );
    scope.ledger.add(openingEntry);
  }
  return wallet;
}

export function newTransaction(
  wallet: Wallet,
  kind: WagerTransactionKind,
  overrides: Partial<CreateWagerTransactionProps> = {},
): WagerTransaction {
  const externalTransactionId = overrides.externalTransactionId ?? `ext-${uuid()}`;
  return WagerTransaction.create({
    id: uuid(),
    providerId: 'provider-a',
    externalTransactionId,
    idempotencyKey: `provider-a:${externalTransactionId}`,
    payloadHash: HASH,
    walletId: wallet.id,
    playerId: wallet.playerId,
    roundId: 'round-1',
    gameId: 'fortune-chimp',
    kind,
    money: brl('25.00'),
    createdAt: new Date(),
    ...overrides,
  });
}

export { WagerTransactionKind as Kind };
