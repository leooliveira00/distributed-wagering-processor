import { z } from 'zod';

export const APP_ROLES = ['api', 'consumer', 'outbox', 'pending'] as const;
export type AppRole = (typeof APP_ROLES)[number];

const rolesSchema = z
  .string()
  .default(APP_ROLES.join(','))
  .transform((value) =>
    value
      .split(',')
      .map((role) => role.trim())
      .filter((role) => role.length > 0),
  )
  .pipe(z.array(z.enum(APP_ROLES)).min(1))
  .transform((roles) => [...new Set(roles)]);

const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().min(1).max(65535).default(3000),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
    APP_ROLES: rolesSchema,

    DATABASE_HOST: z.string().min(1).default('localhost'),
    // 55432 on the host avoids clashing with a locally installed PostgreSQL; containers use 5432.
    DATABASE_PORT: z.coerce.number().int().min(1).max(65535).default(55432),
    DATABASE_NAME: z.string().min(1).default('wagering'),
    DATABASE_USER: z.string().min(1).default('wagering'),
    DATABASE_PASSWORD: z.string().min(1).default('wagering'),
    DATABASE_POOL_MAX: z.coerce.number().int().min(1).default(20),
    /** Max wait for a row lock (hot wallet); exceeding it is a transient failure (503 / retry). */
    DATABASE_LOCK_TIMEOUT_MS: z.coerce.number().int().min(1).default(5_000),
    DATABASE_STATEMENT_TIMEOUT_MS: z.coerce.number().int().min(1).default(15_000),
    /** Max time to open a connection or wait for a free one in the pool. */
    DATABASE_CONNECT_TIMEOUT_MS: z.coerce.number().int().min(1).default(5_000),
    /**
     * Client-side backstop for a server that went silent (network partition): the statement
     * timeout is enforced by the server, so it cannot fire for a query the server never got.
     */
    DATABASE_QUERY_TIMEOUT_MS: z.coerce.number().int().min(1).default(20_000),

    /** PENDING_REFERENCE retries (D11): exponential backoff from base to cap, then REJECTED. */
    PENDING_REFERENCE_BASE_DELAY_MS: z.coerce.number().int().min(1).default(1_000),
    PENDING_REFERENCE_MAX_DELAY_MS: z.coerce.number().int().min(1).default(60_000),
    PENDING_REFERENCE_MAX_ATTEMPTS: z.coerce.number().int().min(1).default(10),
    /** Pending-reference worker (role `pending`): idle delay between scans and items per scan. */
    PENDING_REFERENCE_POLL_INTERVAL_MS: z.coerce.number().int().min(10).default(500),
    PENDING_REFERENCE_BATCH_SIZE: z.coerce.number().int().min(1).max(500).default(20),

    AWS_REGION: z.string().min(1).default('us-east-1'),
    AWS_ENDPOINT_URL: z.url().optional(),
    AWS_ACCESS_KEY_ID: z.string().min(1).default('test'),
    AWS_SECRET_ACCESS_KEY: z.string().min(1).default('test'),
    SQS_WAGER_QUEUE_NAME: z.string().endsWith('.fifo').default('wager-transactions.fifo'),
    SQS_WAGER_DLQ_NAME: z.string().endsWith('.fifo').default('wager-transactions-dlq.fifo'),
    SQS_EVENTS_QUEUE_NAME: z.string().endsWith('.fifo').default('wagering-events.fifo'),
    SQS_MAX_RECEIVE_COUNT: z.coerce.number().int().min(1).default(5),

    /** Consumer of the wager transactions queue (README §10). */
    SQS_CONSUMER_NAME: z.string().min(1).max(128).default('wager-transactions-consumer'),
    SQS_CONSUMER_BATCH_SIZE: z.coerce.number().int().min(1).max(10).default(10),
    SQS_CONSUMER_WAIT_TIME_SECONDS: z.coerce.number().int().min(0).max(20).default(10),
    /**
     * Bounds every SQS call: without them a call on a silent connection (network partition)
     * never returns, and the consumer or the outbox publisher stops for good.
     */
    SQS_CONNECT_TIMEOUT_MS: z.coerce.number().int().min(1).default(3_000),
    SQS_REQUEST_TIMEOUT_MS: z.coerce.number().int().min(1).default(25_000),
    SQS_RETRY_BASE_DELAY_MS: z.coerce.number().int().min(1).default(1_000),
    SQS_RETRY_MAX_DELAY_MS: z.coerce.number().int().min(1).default(60_000),
    /** Must stay below the container stop grace period (docker-compose: 30s). */
    CONSUMER_SHUTDOWN_TIMEOUT_MS: z.coerce.number().int().min(0).default(10_000),

    /** Outbox publisher: lease-based claiming, never drops events (retries forever, capped). */
    OUTBOX_POLL_INTERVAL_MS: z.coerce.number().int().min(10).default(500),
    OUTBOX_BATCH_SIZE: z.coerce.number().int().min(1).max(500).default(50),
    OUTBOX_LEASE_MS: z.coerce.number().int().min(100).default(30_000),
    OUTBOX_RETRY_BASE_DELAY_MS: z.coerce.number().int().min(1).default(1_000),
    OUTBOX_RETRY_MAX_DELAY_MS: z.coerce.number().int().min(1).default(60_000),

    /** Test-only crash points, e.g. "outbox:after-claim". Never set in production. */
    FAULT_INJECTION: z
      .string()
      .default('')
      .transform((value) =>
        value
          .split(',')
          .map((point) => point.trim())
          .filter((point) => point.length > 0),
      )
      .pipe(
        z.array(
          z.enum([
            'outbox:after-claim',
            'outbox:after-publish',
            'consumer:after-commit',
            'pending:before-commit',
          ]),
        ),
      ),
  })
  .superRefine((env, ctx) => {
    // A cap below the base would make the first retry throw instead of failing at startup.
    if (env.PENDING_REFERENCE_MAX_DELAY_MS < env.PENDING_REFERENCE_BASE_DELAY_MS) {
      ctx.addIssue({
        code: 'custom',
        path: ['PENDING_REFERENCE_MAX_DELAY_MS'],
        message: 'Must be greater than or equal to PENDING_REFERENCE_BASE_DELAY_MS',
      });
    }
    // The server must cancel a slow statement first (a clean 57014); the client timeout only
    // fires when nothing answers at all.
    if (env.DATABASE_QUERY_TIMEOUT_MS <= env.DATABASE_STATEMENT_TIMEOUT_MS) {
      ctx.addIssue({
        code: 'custom',
        path: ['DATABASE_QUERY_TIMEOUT_MS'],
        message: 'Must be greater than DATABASE_STATEMENT_TIMEOUT_MS',
      });
    }
    // A long poll legitimately waits SQS_CONSUMER_WAIT_TIME_SECONDS for messages: the request
    // timeout must not cut that wait short.
    if (env.SQS_REQUEST_TIMEOUT_MS <= env.SQS_CONSUMER_WAIT_TIME_SECONDS * 1_000) {
      ctx.addIssue({
        code: 'custom',
        path: ['SQS_REQUEST_TIMEOUT_MS'],
        message: 'Must be greater than SQS_CONSUMER_WAIT_TIME_SECONDS (in milliseconds)',
      });
    }
    // A crash switch must never be armed in production, not even by mistake.
    if (env.NODE_ENV === 'production' && env.FAULT_INJECTION.length > 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['FAULT_INJECTION'],
        message: 'Fault injection is not allowed when NODE_ENV=production',
      });
    }
  });

export type Env = z.infer<typeof envSchema>;

export class InvalidEnvironmentError extends Error {
  constructor(readonly issues: string[]) {
    super(`Invalid environment configuration:\n${issues.join('\n')}`);
    this.name = 'InvalidEnvironmentError';
  }
}

export function loadEnv(source: Record<string, string | undefined> = process.env): Env {
  const result = envSchema.safeParse(source);
  if (!result.success) {
    throw new InvalidEnvironmentError(
      result.error.issues.map((issue) => `  - ${issue.path.join('.')}: ${issue.message}`),
    );
  }
  return result.data;
}
