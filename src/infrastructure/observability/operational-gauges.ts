import { GetQueueAttributesCommand, GetQueueUrlCommand, type SQSClient } from '@aws-sdk/client-sqs';
import { MikroORM } from '@mikro-orm/postgresql';
import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import { Counter, Gauge } from 'prom-client';
import { APP_LOGGER, type AppLogger } from '../../application/ports/logger';
import { ENV } from '../config/config.module';
import { type Env } from '../config/env';
import { SQS_CLIENT } from '../messaging/messaging.module';
import { PrometheusMetrics } from './prometheus-metrics';

const COLLECT_TIMEOUT_MS = 2_000;
/** Several gauges share one query; a scrape reads them within this window. */
const SAMPLE_TTL_MS = 1_000;

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

/** Memoizes one async sample for a short time, so gauges fed by the same query share it. */
function sampled<T>(read: () => Promise<T>): () => Promise<T> {
  let cached: { at: number; value: Promise<T> } | undefined;
  return () => {
    if (!cached || Date.now() - cached.at > SAMPLE_TTL_MS) {
      cached = { at: Date.now(), value: withTimeout(read(), COLLECT_TIMEOUT_MS) };
    }
    return cached.value;
  };
}

interface OutboxSample {
  pending: number;
  oldestAgeSeconds: number;
}

/**
 * Gauges of SHARED state, read when Prometheus scrapes `/metrics` (README §12: outbox lag and
 * messages in the DLQ). Each is registered only by the role responsible for it (outbox lag by
 * `outbox`, queue depths by `consumer`), so a cluster does not run the same query once per
 * instance. A failed or slow read exports no stale value: the gauge is reset, the failure is
 * counted (visible from the next scrape, as the counter is serialized alongside) and logged, and
 * the scrape still answers.
 */
@Injectable()
export class OperationalGauges implements OnModuleInit {
  private readonly failures: Counter;
  private queueUrls: Promise<{ main: string; deadLetter: string }> | undefined;

  constructor(
    private readonly metrics: PrometheusMetrics,
    private readonly orm: MikroORM,
    @Inject(SQS_CLIENT) private readonly sqs: SQSClient,
    @Inject(ENV) private readonly env: Env,
    @Inject(APP_LOGGER) private readonly logger: AppLogger,
  ) {
    this.failures = new Counter({
      name: 'metrics_collection_failures_total',
      help: 'Gauge reads that failed or timed out during a scrape, by collector',
      labelNames: ['collector'],
      registers: [metrics.registry],
    });
  }

  onModuleInit(): void {
    if (this.env.APP_ROLES.includes('outbox')) this.registerOutboxGauges();
    if (this.env.APP_ROLES.includes('consumer')) this.registerQueueGauges();
  }

  private registerOutboxGauges(): void {
    const sample = sampled(() => this.readOutbox());
    this.gauge({
      name: 'outbox_pending_events',
      help: 'Events committed but not yet published',
      collector: 'outbox',
      read: async (gauge) => {
        gauge.set((await sample()).pending);
      },
    });
    this.gauge({
      name: 'outbox_oldest_pending_age_seconds',
      help: 'Age of the oldest unpublished event (outbox lag); 0 when nothing is pending',
      collector: 'outbox',
      read: async (gauge) => {
        gauge.set((await sample()).oldestAgeSeconds);
      },
    });
  }

  private registerQueueGauges(): void {
    const sample = sampled(() => this.readQueues());
    this.gauge({
      name: 'sqs_queue_messages',
      help: 'Messages in the wager queue and its dead-letter queue (visible + in flight + delayed)',
      labelNames: ['queue'],
      collector: 'sqs',
      read: async (gauge) => {
        const depths = await sample();
        gauge.set({ queue: 'main' }, depths.main);
        gauge.set({ queue: 'dead_letter' }, depths.deadLetter);
      },
    });
  }

  /** A gauge read at scrape time; a failed read exports nothing instead of a stale value. */
  private gauge(definition: {
    name: string;
    help: string;
    labelNames?: string[];
    collector: string;
    read: (gauge: Gauge) => Promise<void>;
  }): Gauge {
    const onFailure = (gauge: Gauge, error: unknown) => {
      this.failed(gauge, definition.collector, error);
    };
    return new Gauge({
      name: definition.name,
      help: definition.help,
      labelNames: definition.labelNames ?? [],
      registers: [this.metrics.registry],
      async collect(this: Gauge) {
        try {
          await definition.read(this);
        } catch (error) {
          onFailure(this, error);
        }
      },
    });
  }

  private failed(target: Gauge, collector: string, error: unknown): void {
    target.reset();
    this.failures.inc({ collector });
    this.logger.warn('Metric collection failed', {
      collector,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  /** Served by outbox_messages_unpublished_idx (occurred_at, partial on published_at is null). */
  private async readOutbox(): Promise<OutboxSample> {
    const [row] = await this.orm.em
      .fork()
      .execute<{ pending: number; oldest_age_seconds: number }[]>(
        `select count(*)::int as pending,
                coalesce(extract(epoch from now() - min(occurred_at)), 0)::float8 as oldest_age_seconds
           from outbox_messages
          where published_at is null`,
      );
    return {
      pending: row?.pending ?? 0,
      oldestAgeSeconds: Math.max(0, row?.oldest_age_seconds ?? 0),
    };
  }

  private async readQueues(): Promise<{ main: number; deadLetter: number }> {
    this.queueUrls ??= Promise.all([
      this.queueUrl(this.env.SQS_WAGER_QUEUE_NAME),
      this.queueUrl(this.env.SQS_WAGER_DLQ_NAME),
    ]).then(([main, deadLetter]) => ({ main, deadLetter }));
    const urls = await this.queueUrls.catch((error: unknown) => {
      this.queueUrls = undefined; // resolve again on the next scrape
      throw error;
    });
    const [main, deadLetter] = await Promise.all([
      this.depth(urls.main),
      this.depth(urls.deadLetter),
    ]);
    return { main, deadLetter };
  }

  private async queueUrl(name: string): Promise<string> {
    const { QueueUrl } = await this.sqs.send(new GetQueueUrlCommand({ QueueName: name }));
    if (!QueueUrl) throw new Error(`queue ${name} has no URL`);
    return QueueUrl;
  }

  private async depth(queueUrl: string): Promise<number> {
    const { Attributes = {} } = await this.sqs.send(
      new GetQueueAttributesCommand({
        QueueUrl: queueUrl,
        AttributeNames: [
          'ApproximateNumberOfMessages',
          'ApproximateNumberOfMessagesNotVisible',
          'ApproximateNumberOfMessagesDelayed',
        ],
      }),
    );
    return (
      Number(Attributes.ApproximateNumberOfMessages ?? '0') +
      Number(Attributes.ApproximateNumberOfMessagesNotVisible ?? '0') +
      Number(Attributes.ApproximateNumberOfMessagesDelayed ?? '0')
    );
  }
}
