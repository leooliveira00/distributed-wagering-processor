import { NotFoundError } from '../errors';
import { type UnitOfWork } from '../ports/unit-of-work';
import { decodeLedgerCursor, encodeLedgerCursor } from './ledger-cursor';
import {
  type LedgerPageView,
  toLedgerEntryView,
  toWalletView,
  type WalletView,
} from './wallet-views';

export const LEDGER_PAGE_DEFAULT = 50;
export const LEDGER_PAGE_MAX = 100;

export function walletNotFound(walletId: string): NotFoundError {
  return new NotFoundError('WALLET_NOT_FOUND', `Wallet ${walletId} not found`);
}

export class GetWallet {
  constructor(private readonly unitOfWork: UnitOfWork) {}

  async execute(walletId: string): Promise<WalletView> {
    const wallet = await this.unitOfWork.run((scope) => scope.wallets.findById(walletId), {
      readOnly: true,
    });
    if (!wallet) throw walletNotFound(walletId);
    return toWalletView(wallet);
  }
}

export interface ListWalletLedgerQuery {
  walletId: string;
  cursor?: string | undefined;
  limit: number;
}

/** Ledger in wallet-version order with a stable, opaque cursor. */
export class ListWalletLedger {
  constructor(private readonly unitOfWork: UnitOfWork) {}

  async execute(query: ListWalletLedgerQuery): Promise<LedgerPageView> {
    const afterVersion = query.cursor === undefined ? undefined : decodeLedgerCursor(query.cursor);

    const page = await this.unitOfWork.run(
      async (scope) => {
        const wallet = await scope.wallets.findById(query.walletId);
        if (!wallet) throw walletNotFound(query.walletId);
        return scope.ledger.listByWallet(query.walletId, {
          limit: query.limit,
          ...(afterVersion !== undefined ? { afterVersion } : {}),
        });
      },
      { readOnly: true },
    );

    return {
      items: page.entries.map(toLedgerEntryView),
      nextCursor:
        page.nextAfterVersion === undefined ? null : encodeLedgerCursor(page.nextAfterVersion),
    };
  }
}
