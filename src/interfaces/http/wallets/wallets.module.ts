import { Module } from '@nestjs/common';
import {
  CLOCK,
  type Clock,
  ID_GENERATOR,
  type IdGenerator,
} from '../../../application/ports/system';
import { UNIT_OF_WORK, type UnitOfWork } from '../../../application/ports/unit-of-work';
import { CreateWallet } from '../../../application/wallets/create-wallet';
import { GetWallet, ListWalletLedger } from '../../../application/wallets/wallet-queries';
import { WalletsController } from './wallets.controller';

/**
 * Use cases are framework-free classes; Nest only wires their ports here.
 */
@Module({
  controllers: [WalletsController],
  providers: [
    {
      provide: CreateWallet,
      inject: [UNIT_OF_WORK, ID_GENERATOR, CLOCK],
      useFactory: (unitOfWork: UnitOfWork, ids: IdGenerator, clock: Clock) =>
        new CreateWallet(unitOfWork, ids, clock),
    },
    {
      provide: GetWallet,
      inject: [UNIT_OF_WORK],
      useFactory: (unitOfWork: UnitOfWork) => new GetWallet(unitOfWork),
    },
    {
      provide: ListWalletLedger,
      inject: [UNIT_OF_WORK],
      useFactory: (unitOfWork: UnitOfWork) => new ListWalletLedger(unitOfWork),
    },
  ],
})
export class WalletsModule {}
