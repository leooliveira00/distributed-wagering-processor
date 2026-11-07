/** One request as seen by the client. `status` 0 means the connection itself failed. */
export interface Sample {
  latencyMs: number;
  status: number;
  /** Whether this request resent a key already used (an expected idempotent replay). */
  replay: boolean;
}

export interface LatencySummary {
  count: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
}

/** Nearest-rank percentile over the exact samples: no histogram, no interpolation. */
export function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0;
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length, Math.max(rank, 1)) - 1] ?? 0;
}

export function summarize(latencies: readonly number[]): LatencySummary {
  const sorted = [...latencies].sort((a, b) => a - b);
  return {
    count: sorted.length,
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    p99: percentile(sorted, 99),
    max: sorted.at(-1) ?? 0,
  };
}

/**
 * Outcome classes, from the provider's point of view:
 * - business: the request was decided (201 processed, 202 pending, 422 rejected by a rule);
 * - transient: 503, the provider would resend the same request later;
 * - error: any other status or a failed connection.
 */
export function classify(status: number): 'business' | 'transient' | 'error' {
  if (status === 201 || status === 202 || status === 422) return 'business';
  if (status === 503) return 'transient';
  return 'error';
}

export const round = (value: number, digits = 1): number => {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
};
