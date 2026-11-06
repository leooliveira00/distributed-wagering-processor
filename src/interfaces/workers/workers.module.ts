import { Module } from '@nestjs/common';
import { PublishOutbox } from '../../application/outbox/publish-outbox';
import { FAULT_INJECTOR, type FaultInjector } from '../../application/ports/fault-injector';
import { APP_LOGGER, type AppLogger } from '../../application/ports/logger';
import {
  MESSAGE_PUBLISHER,
  type MessagePublisher,
} from '../../application/ports/message-publisher';
import { METRICS, type Metrics } from '../../application/ports/metrics';
import { CLOCK, type Clock } from '../../application/ports/system';
import { UNIT_OF_WORK, type UnitOfWork } from '../../application/ports/unit-of-work';
import { ENV } from '../../infrastructure/config/config.module';
import { type Env } from '../../infrastructure/config/env';
import { WageringModule } from '../http/wagering/wagering.module';
import { OutboxPublisherWorker } from './outbox-publisher.worker';
import { SqsConsumerWorker } from './sqs-consumer.worker';

@Module({
  imports: [WageringModule],
  providers: [
    {
      provide: PublishOutbox,
      inject: [UNIT_OF_WORK, MESSAGE_PUBLISHER, CLOCK, METRICS, APP_LOGGER, FAULT_INJECTOR, ENV],
      useFactory: (
        unitOfWork: UnitOfWork,
        publisher: MessagePublisher,
        clock: Clock,
        metrics: Metrics,
        logger: AppLogger,
        faults: FaultInjector,
        env: Env,
      ) =>
        new PublishOutbox(unitOfWork, publisher, clock, metrics, logger, faults, {
          batchSize: env.OUTBOX_BATCH_SIZE,
          leaseMs: env.OUTBOX_LEASE_MS,
          retry: { baseMs: env.OUTBOX_RETRY_BASE_DELAY_MS, capMs: env.OUTBOX_RETRY_MAX_DELAY_MS },
        }),
    },
    OutboxPublisherWorker,
    SqsConsumerWorker,
  ],
})
export class WorkersModule {}
