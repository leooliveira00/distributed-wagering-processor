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

const envSchema = z.object({
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

  /** PENDING_REFERENCE retries (D11): exponential backoff from base to cap, then REJECTED. */
  PENDING_REFERENCE_BASE_DELAY_MS: z.coerce.number().int().min(1).default(1_000),
  PENDING_REFERENCE_MAX_DELAY_MS: z.coerce.number().int().min(1).default(60_000),
  PENDING_REFERENCE_MAX_ATTEMPTS: z.coerce.number().int().min(1).default(10),

  AWS_REGION: z.string().min(1).default('us-east-1'),
  AWS_ENDPOINT_URL: z.url().optional(),
  AWS_ACCESS_KEY_ID: z.string().min(1).default('test'),
  AWS_SECRET_ACCESS_KEY: z.string().min(1).default('test'),
  SQS_WAGER_QUEUE_NAME: z.string().endsWith('.fifo').default('wager-transactions.fifo'),
  SQS_WAGER_DLQ_NAME: z.string().endsWith('.fifo').default('wager-transactions-dlq.fifo'),
  SQS_EVENTS_QUEUE_NAME: z.string().endsWith('.fifo').default('wagering-events.fifo'),
  SQS_MAX_RECEIVE_COUNT: z.coerce.number().int().min(1).default(5),
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
