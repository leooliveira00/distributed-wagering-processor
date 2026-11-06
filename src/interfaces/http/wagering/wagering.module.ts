import { Module } from '@nestjs/common';
import {
  CLOCK,
  type Clock,
  ID_GENERATOR,
  type IdGenerator,
} from '../../../application/ports/system';
import { METRICS, type Metrics } from '../../../application/ports/metrics';
import { UNIT_OF_WORK, type UnitOfWork } from '../../../application/ports/unit-of-work';
import { SubmitWagerTransaction } from '../../../application/wagering/submit-wager-transaction';
import {
  PENDING_REFERENCE_POLICY,
  type PendingReferencePolicy,
} from '../../../application/wagering/wager-command';
import { GetWagerTransaction } from '../../../application/wagering/wager-queries';
import { ENV } from '../../../infrastructure/config/config.module';
import { type Env } from '../../../infrastructure/config/env';
import { WageringController } from './wagering.controller';

@Module({
  controllers: [WageringController],
  providers: [
    {
      provide: PENDING_REFERENCE_POLICY,
      inject: [ENV],
      useFactory: (env: Env): PendingReferencePolicy => ({
        backoff: {
          baseMs: env.PENDING_REFERENCE_BASE_DELAY_MS,
          capMs: env.PENDING_REFERENCE_MAX_DELAY_MS,
        },
        maxAttempts: env.PENDING_REFERENCE_MAX_ATTEMPTS,
      }),
    },
    {
      provide: SubmitWagerTransaction,
      inject: [UNIT_OF_WORK, ID_GENERATOR, CLOCK, PENDING_REFERENCE_POLICY, METRICS],
      useFactory: (
        unitOfWork: UnitOfWork,
        ids: IdGenerator,
        clock: Clock,
        policy: PendingReferencePolicy,
        metrics: Metrics,
      ) => new SubmitWagerTransaction(unitOfWork, ids, clock, policy, metrics),
    },
    {
      provide: GetWagerTransaction,
      inject: [UNIT_OF_WORK],
      useFactory: (unitOfWork: UnitOfWork) => new GetWagerTransaction(unitOfWork),
    },
  ],
  exports: [SubmitWagerTransaction, PENDING_REFERENCE_POLICY],
})
export class WageringModule {}
