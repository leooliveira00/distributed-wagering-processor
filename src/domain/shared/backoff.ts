export interface BackoffPolicy {
  /** Delay before the first retry. */
  baseMs: number;
  /** Upper bound for any single delay. */
  capMs: number;
}

/**
 * Exponential backoff without jitter: base * 2^(attempt - 1), capped.
 * Deterministic on purpose so retries are reproducible in tests. With few instances the
 * thundering-herd risk jitter addresses is low; this trade-off is documented.
 */
export function backoffDelayMs(attempt: number, policy: BackoffPolicy): number {
  if (!Number.isInteger(attempt) || attempt < 1) {
    throw new RangeError(`attempt must be a positive integer, received ${String(attempt)}`);
  }
  if (policy.baseMs <= 0 || policy.capMs < policy.baseMs) {
    throw new RangeError('backoff policy requires 0 < baseMs <= capMs');
  }
  // Cap the exponent too, so very large attempt counts never overflow to Infinity.
  const exponent = Math.min(attempt - 1, 30);
  return Math.min(policy.baseMs * 2 ** exponent, policy.capMs);
}

export function nextAttemptAt(now: Date, attempt: number, policy: BackoffPolicy): Date {
  return new Date(now.getTime() + backoffDelayMs(attempt, policy));
}
