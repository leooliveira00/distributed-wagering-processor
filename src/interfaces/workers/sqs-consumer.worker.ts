import { type SQSClient } from '@aws-sdk/client-sqs';
import {
  type BeforeApplicationShutdown,
  Inject,
  Injectable,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import { FAULT_INJECTOR, type FaultInjector } from '../../application/ports/fault-injector';
import { APP_LOGGER, type AppLogger } from '../../application/ports/logger';
import { METRICS, type Metrics } from '../../application/ports/metrics';
import { SubmitWagerTransaction } from '../../application/wagering/submit-wager-transaction';
import { ENV } from '../../infrastructure/config/config.module';
import { type Env } from '../../infrastructure/config/env';
import { SQS_CLIENT } from '../../infrastructure/messaging/messaging.module';
import { WagerMessageConsumer } from '../sqs/wager-message-consumer';

/** Runs the queue consumer in instances whose APP_ROLES include `consumer`. */
@Injectable()
export class SqsConsumerWorker implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private readonly consumer: WagerMessageConsumer | undefined;

  constructor(
    @Inject(ENV) env: Env,
    @Inject(SQS_CLIENT) sqs: SQSClient,
    submit: SubmitWagerTransaction,
    @Inject(METRICS) metrics: Metrics,
    @Inject(APP_LOGGER) logger: AppLogger,
    @Inject(FAULT_INJECTOR) faults: FaultInjector,
  ) {
    if (env.APP_ROLES.includes('consumer')) {
      this.consumer = new WagerMessageConsumer(sqs, submit, metrics, logger, faults, {
        consumerName: env.SQS_CONSUMER_NAME,
        queueName: env.SQS_WAGER_QUEUE_NAME,
        deadLetterQueueName: env.SQS_WAGER_DLQ_NAME,
        batchSize: env.SQS_CONSUMER_BATCH_SIZE,
        waitTimeSeconds: env.SQS_CONSUMER_WAIT_TIME_SECONDS,
        retry: { baseMs: env.SQS_RETRY_BASE_DELAY_MS, capMs: env.SQS_RETRY_MAX_DELAY_MS },
        shutdownTimeoutMs: env.CONSUMER_SHUTDOWN_TIMEOUT_MS,
        idleOnErrorMs: 1_000,
      });
    }
  }

  onApplicationBootstrap(): void {
    this.consumer?.start();
  }

  /** SIGTERM: drain in-flight messages before the database connection closes. */
  async beforeApplicationShutdown(): Promise<void> {
    await this.consumer?.stop();
  }
}
