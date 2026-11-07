import {
  type BeforeApplicationShutdown,
  Inject,
  Injectable,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import { PublishOutbox } from '../../application/outbox/publish-outbox';
import { APP_LOGGER, type AppLogger } from '../../application/ports/logger';
import { ENV } from '../../infrastructure/config/config.module';
import { type Env } from '../../infrastructure/config/env';
import { PollingLoop } from './polling-loop';

/** Runs the outbox publisher in instances whose APP_ROLES include `outbox`. */
@Injectable()
export class OutboxPublisherWorker implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private readonly loop: PollingLoop | undefined;

  constructor(
    @Inject(ENV) env: Env,
    publishOutbox: PublishOutbox,
    @Inject(APP_LOGGER) logger: AppLogger,
  ) {
    if (env.APP_ROLES.includes('outbox')) {
      this.loop = new PollingLoop(
        'outbox-publisher',
        env.OUTBOX_POLL_INTERVAL_MS,
        async () => (await publishOutbox.runOnce()).claimed > 0,
        logger,
      );
    }
  }

  onApplicationBootstrap(): void {
    this.loop?.start();
  }

  /** Stops before the database connection closes, letting the current batch finish. */
  async beforeApplicationShutdown(): Promise<void> {
    await this.loop?.stop();
  }
}
