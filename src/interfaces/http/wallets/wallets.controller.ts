import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Inject,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import { z } from 'zod';
import { ID_GENERATOR, type IdGenerator } from '../../../application/ports/system';
import { CreateWallet } from '../../../application/wallets/create-wallet';
import {
  ReconcileWallet,
  type ReconciliationView,
} from '../../../application/wallets/reconcile-wallet';
import {
  GetWallet,
  LEDGER_PAGE_DEFAULT,
  LEDGER_PAGE_MAX,
  ListWalletLedger,
} from '../../../application/wallets/wallet-queries';
import { type LedgerPageView, type WalletView } from '../../../application/wallets/wallet-views';
import { requestContextFrom } from '../request-context';
import { parseInput } from '../validation';

/** Shape only: the amount format itself is validated by the Money value object. */
const moneySchema = z.strictObject({ amount: z.string(), currency: z.string() });

const createWalletSchema = z.strictObject({
  playerId: z.uuid(),
  initialBalance: moneySchema,
});

const walletIdSchema = z.uuid();

const ledgerQuerySchema = z.object({
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(LEDGER_PAGE_MAX).default(LEDGER_PAGE_DEFAULT),
});

@Controller('wallets')
export class WalletsController {
  constructor(
    private readonly createWallet: CreateWallet,
    private readonly getWallet: GetWallet,
    private readonly listLedger: ListWalletLedger,
    private readonly reconcileWallet: ReconcileWallet,
    @Inject(ID_GENERATOR) private readonly ids: IdGenerator,
  ) {}

  @Post()
  @HttpCode(201)
  create(
    @Body() body: unknown,
    @Headers() headers: Record<string, string | undefined>,
  ): Promise<WalletView> {
    const command = parseInput(createWalletSchema, body);
    return this.createWallet.execute(command, requestContextFrom(headers, this.ids));
  }

  @Get(':walletId')
  get(@Param('walletId') walletId: string): Promise<WalletView> {
    return this.getWallet.execute(parseInput(walletIdSchema, walletId));
  }

  @Get(':walletId/ledger')
  ledger(@Param('walletId') walletId: string, @Query() query: unknown): Promise<LedgerPageView> {
    const { cursor, limit } = parseInput(ledgerQuerySchema, query);
    return this.listLedger.execute({
      walletId: parseInput(walletIdSchema, walletId),
      cursor,
      limit,
    });
  }

  /** 200 even when inconsistent: the check succeeded; the divergence is reported in the body. */
  @Post(':walletId/reconciliation')
  @HttpCode(200)
  reconcile(@Param('walletId') walletId: string): Promise<ReconciliationView> {
    return this.reconcileWallet.execute(parseInput(walletIdSchema, walletId));
  }
}
