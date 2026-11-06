import { WagerTransactionProcessed } from '../../domain/messaging/events/wager-transaction-processed';
import { WalletBalanceChanged } from '../../domain/messaging/events/wallet-balance-changed';
import { type EventContext } from '../../domain/messaging/integration-event';
import { OutboxMessage } from '../../domain/messaging/outbox-message';
import { Money, type MoneyProps } from '../../domain/money/money';
import { WagerTransaction } from '../../domain/wagering/wager-transaction';
import { Wallet } from '../../domain/wallet/wallet';
import { ConflictError, UniqueViolationError } from '../errors';
import { type Clock, type IdGenerator } from '../ports/system';
import { type UnitOfWork } from '../ports/unit-of-work';
import { payloadHash } from '../shared/canonical-json';
import { type RequestContext } from '../shared/request-context';
import { toWalletView, type WalletView } from './wallet-views';

export interface CreateWalletCommand {
  playerId: string;
  initialBalance: MoneyProps;
}

const WALLET_UNIQUE_CONSTRAINT = 'wallets_player_currency_uq';

function walletAlreadyExists(playerId: string, currency: string): ConflictError {
  return new ConflictError(
    'WALLET_ALREADY_EXISTS',
    `Player ${playerId} already has a ${currency} wallet`,
  );
}

/**
 * Opens a wallet. A positive initial balance produces, in the same SQL transaction, the internal
 * OPENING transaction, its CREDIT ledger entry and the integration events (README §9).
 */
export class CreateWallet {
  constructor(
    private readonly unitOfWork: UnitOfWork,
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
  ) {}

  async execute(command: CreateWalletCommand, context: RequestContext): Promise<WalletView> {
    const initialBalance = Money.from(command.initialBalance);
    try {
      return await this.unitOfWork.run(async (scope) => {
        // Fast path for the common case; the unique constraint still decides under races.
        const existing = await scope.wallets.findByPlayerAndCurrency(
          command.playerId,
          initialBalance.currency,
        );
        if (existing) throw walletAlreadyExists(command.playerId, initialBalance.currency);

        const at = this.clock.now();
        const walletId = this.ids.next();
        const openingTransactionId = this.ids.next();
        const { wallet, openingEntry } = Wallet.open({
          id: walletId,
          playerId: command.playerId,
          initialBalance,
          openingTransactionId,
          openingEntryId: this.ids.next(),
          at,
        });
        scope.wallets.add(wallet);

        if (openingEntry) {
          const opening = WagerTransaction.createOpening({
            id: openingTransactionId,
            walletId,
            playerId: wallet.playerId,
            money: initialBalance,
            payloadHash: payloadHash({
              walletId,
              playerId: wallet.playerId,
              initialBalance: initialBalance.toJSON(),
            }),
            at,
          });
          scope.transactions.add(opening);
          scope.ledger.add(openingEntry);

          const eventContext = (): EventContext => ({
            eventId: this.ids.next(),
            correlationId: context.correlationId,
            causationId: context.causationId,
            occurredAt: at,
          });
          scope.outbox.add(
            OutboxMessage.enqueue(WagerTransactionProcessed.from(opening, eventContext())),
          );
          scope.outbox.add(
            OutboxMessage.enqueue(WalletBalanceChanged.from(wallet, openingEntry, eventContext())),
          );
        }
        return toWalletView(wallet);
      });
    } catch (error) {
      if (error instanceof UniqueViolationError && error.constraint === WALLET_UNIQUE_CONSTRAINT) {
        throw walletAlreadyExists(command.playerId, initialBalance.currency);
      }
      throw error;
    }
  }
}
