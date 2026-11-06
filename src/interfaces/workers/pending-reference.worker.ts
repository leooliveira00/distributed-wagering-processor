import {
  type BeforeApplicationShutdown,
  Inject,
  Injectable,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import { APP_LOGGER, type AppLogger } from '../../application/ports/logger';
import { ResolvePendingReferences } from '../../application/wagering/resolve-pending-references';
import { ENV } from '../../infrastructure/config/config.module';
import { type Env } from '../../infrastructure/config/env';
import { PollingLoop } from './polling-loop';

/** Runs the pending-reference worker in instances whose APP_ROLES include `pending`. */
@Injectable()
export class PendingReferenceWorker implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private readonly loop: PollingLoop | undefined;

  constructor(
    @Inject(ENV) env: Env,
    resolvePendingReferences: ResolvePendingReferences,
    @Inject(APP_LOGGER) logger: AppLogger,
  ) {
    if (env.APP_ROLES.includes('pending')) {
      this.loop = new PollingLoop(
        'pending-reference',
        env.PENDING_REFERENCE_POLL_INTERVAL_MS,
        // A full batch means more may be due: go again without waiting.
        async () =>
          (await resolvePendingReferences.runOnce()).attempted >= env.PENDING_REFERENCE_BATCH_SIZE,
        logger,
      );
    }
  }

  onApplicationBootstrap(): void {
    this.loop?.start();
  }

  /** Lets the current attempt commit or roll back before the database connection closes. */
  async beforeApplicationShutdown(): Promise<void> {
    await this.loop?.stop();
  }
}
