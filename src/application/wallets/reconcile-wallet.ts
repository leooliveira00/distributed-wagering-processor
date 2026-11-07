import { type MoneyProps } from '../../domain/money/money';
import { type AppLogger } from '../ports/logger';
import { type Metrics } from '../ports/metrics';
import { type UnitOfWork } from '../ports/unit-of-work';
import { walletNotFound } from './wallet-queries';

export interface ReconciliationView {
  walletId: string;
  storedBalance: MoneyProps;
  calculatedBalance: MoneyProps;
  difference: MoneyProps;
  consistent: boolean;
  checkedEntries: number;
}

/**
 * Compares the materialized balance with the balance rebuilt from the ledger (README §9).
 *
 * Both reads run in one REPEATABLE READ snapshot: a commit landing between them can never show
 * up as a false divergence, and no writer is blocked. Divergences are never corrected here:
 * they are logged, counted and reported.
 */
export class ReconcileWallet {
  constructor(
    private readonly unitOfWork: UnitOfWork,
    private readonly metrics: Metrics,
    private readonly logger: AppLogger,
  ) {}

  async execute(walletId: string): Promise<ReconciliationView> {
    const { wallet, summary } = await this.unitOfWork.run(
      async (scope) => {
        const found = await scope.wallets.findById(walletId);
        if (!found) throw walletNotFound(walletId);
        return { wallet: found, summary: await scope.ledger.summarize(walletId, found.currency) };
      },
      { isolation: 'snapshot', readOnly: true },
    );

    const calculated = summary.credits.subtract(summary.debits);
    const difference = wallet.balance.subtract(calculated);
    const consistent = difference.isZero();

    this.metrics.increment('wallet_reconciliations_total', {
      result: consistent ? 'consistent' : 'divergent',
    });
    if (!consistent) {
      this.metrics.increment('wallet_reconciliation_divergences_total');
      // Only the divergence itself is logged; full balances stay in the authorized response.
      // Which wallet, never how much (README §12): the amounts are in the response and metrics.
      this.logger.warn('Wallet balance diverges from its ledger', {
        walletId,
        currency: wallet.currency,
        checkedEntries: summary.entries,
        walletVersion: wallet.version,
      });
    }

    return {
      walletId,
      storedBalance: wallet.balance.toJSON(),
      calculatedBalance: calculated.toJSON(),
      difference: difference.toJSON(),
      consistent,
      checkedEntries: summary.entries,
    };
  }
}
