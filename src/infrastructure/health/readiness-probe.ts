import { GetQueueAttributesCommand, GetQueueUrlCommand, type SQSClient } from '@aws-sdk/client-sqs';
import { MikroORM } from '@mikro-orm/postgresql';
import { Inject, Injectable } from '@nestjs/common';
import { APP_LOGGER, type AppLogger } from '../../application/ports/logger';
import { ENV } from '../config/config.module';
import { type Env } from '../config/env';
import { SQS_CLIENT } from '../messaging/messaging.module';

export type DependencyName = 'postgres' | 'sqs';

/** Up or down and how long the check took. Never the error text: the endpoint is public. */
export interface DependencyStatus {
  status: 'up' | 'down';
  latencyMs: number;
}

export interface ReadinessReport {
  status: 'ok' | 'unavailable';
  checks: Record<DependencyName, DependencyStatus>;
}

const CHECK_TIMEOUT_MS = 2_000;

/** Enough to diagnose from the log: some driver errors carry only a name and a code. */
function describeError(error: unknown): { error: string; errorCode: string | undefined } {
  if (!(error instanceof Error)) return { error: String(error), errorCode: undefined };
  const code = (error as { code?: unknown }).code;
  return {
    error: error.message || error.name,
    errorCode: typeof code === 'string' ? code : undefined,
  };
}

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    work,
    new Promise<never>((_, reject) => {
      setTimeout(() => {
        reject(new Error(`timed out after ${String(ms)}ms`));
      }, ms).unref();
    }),
  ]);
}

/**
 * Readiness (README §8, §12): PostgreSQL and SQS reachable. Both checks run in parallel, each
 * bounded by a timeout, so a hanging dependency cannot hang the probe. The reason of a failure
 * goes to the log, never to the response: hosts, ports and driver messages stay internal.
 */
@Injectable()
export class ReadinessProbe {
  private queueUrl: Promise<string> | undefined;

  constructor(
    private readonly orm: MikroORM,
    @Inject(SQS_CLIENT) private readonly sqs: SQSClient,
    @Inject(ENV) private readonly env: Env,
    @Inject(APP_LOGGER) private readonly logger: AppLogger,
  ) {}

  async check(): Promise<ReadinessReport> {
    const [postgres, sqs] = await Promise.all([
      this.run('postgres', () => this.pingPostgres()),
      this.run('sqs', () => this.pingSqs()),
    ]);
    return {
      status: postgres.status === 'up' && sqs.status === 'up' ? 'ok' : 'unavailable',
      checks: { postgres, sqs },
    };
  }

  private async run(name: DependencyName, ping: () => Promise<void>): Promise<DependencyStatus> {
    const started = performance.now();
    const latencyMs = () => Math.round(performance.now() - started);
    try {
      await withTimeout(ping(), CHECK_TIMEOUT_MS);
      return { status: 'up', latencyMs: latencyMs() };
    } catch (error) {
      this.logger.warn('Readiness check failed', { dependency: name, ...describeError(error) });
      return { status: 'down', latencyMs: latencyMs() };
    }
  }

  private async pingPostgres(): Promise<void> {
    await this.orm.em.fork().execute('select 1');
  }

  /** The wager queue must exist and answer, not just the SQS endpoint. */
  private async pingSqs(): Promise<void> {
    this.queueUrl ??= this.resolveQueueUrl();
    let queueUrl: string;
    try {
      queueUrl = await this.queueUrl;
    } catch (error) {
      this.queueUrl = undefined; // resolve again on the next probe
      throw error;
    }
    await this.sqs.send(
      new GetQueueAttributesCommand({ QueueUrl: queueUrl, AttributeNames: ['QueueArn'] }),
    );
  }

  private async resolveQueueUrl(): Promise<string> {
    const { QueueUrl } = await this.sqs.send(
      new GetQueueUrlCommand({ QueueName: this.env.SQS_WAGER_QUEUE_NAME }),
    );
    if (!QueueUrl) throw new Error(`queue ${this.env.SQS_WAGER_QUEUE_NAME} has no URL`);
    return QueueUrl;
  }
}
