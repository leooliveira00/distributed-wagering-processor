/**
 * Server-side view of a scenario: `/metrics` of every instance is read before and after, and the
 * report uses the difference. Each process exposes only its own counters, so they are summed
 * across instances, as a Prometheus query would.
 */
export type Scrape = string[];

interface Line {
  name: string;
  labels: Record<string, string>;
  value: number;
}

function parse(text: string): Line[] {
  const lines: Line[] = [];
  for (const raw of text.split('\n')) {
    if (raw.startsWith('#') || raw.trim().length === 0) continue;
    const match = /^([a-zA-Z_:][a-zA-Z0-9_:]*)(?:\{(.*)\})?\s+(\S+)$/.exec(raw);
    if (!match?.[1] || match[3] === undefined) continue;
    const labels: Record<string, string> = {};
    for (const pair of (match[2] ?? '').matchAll(/(\w+)="([^"]*)"/g)) {
      if (pair[1] !== undefined && pair[2] !== undefined) labels[pair[1]] = pair[2];
    }
    lines.push({ name: match[1], labels, value: Number(match[3]) });
  }
  return lines;
}

export async function scrape(urls: readonly string[]): Promise<Scrape> {
  return Promise.all(
    urls.map(async (url) =>
      (await fetch(`${url}/metrics`, { signal: AbortSignal.timeout(10_000) })).text(),
    ),
  );
}

/** Sum of every sample of `name` whose labels include `filter`, across all instances. */
export function total(snapshot: Scrape, name: string, filter: Record<string, string> = {}): number {
  let sum = 0;
  for (const text of snapshot) {
    for (const line of parse(text)) {
      if (line.name !== name) continue;
      if (Object.entries(filter).every(([key, value]) => line.labels[key] === value)) {
        sum += line.value;
      }
    }
  }
  return sum;
}

/** Counter growth per value of `label` (e.g. lock conflicts per reason). */
export function deltaBy(
  before: Scrape,
  after: Scrape,
  name: string,
  label: string,
): Record<string, number> {
  const values = new Set<string>();
  for (const text of after) {
    for (const line of parse(text)) {
      const value = line.labels[label];
      if (line.name === name && value !== undefined) values.add(value);
    }
  }
  const result: Record<string, number> = {};
  for (const value of values) {
    const delta = total(after, name, { [label]: value }) - total(before, name, { [label]: value });
    if (delta > 0) result[value] = delta;
  }
  return result;
}

export const delta = (before: Scrape, after: Scrape, name: string) =>
  total(after, name) - total(before, name);

/** Mean of a histogram over the interval, in milliseconds (from `_sum` and `_count`). */
export function histogramMeanMs(before: Scrape, after: Scrape, name: string): number {
  const count = delta(before, after, `${name}_count`);
  return count === 0 ? 0 : (delta(before, after, `${name}_sum`) / count) * 1000;
}

/**
 * Quantile of a histogram over the interval, in milliseconds, from its cumulative buckets.
 * Approximate by nature: the answer is the upper bound of the bucket where the quantile falls.
 */
export function histogramQuantileMs(
  before: Scrape,
  after: Scrape,
  name: string,
  quantile: number,
): number {
  const bounds = new Set<string>();
  for (const text of after) {
    for (const line of parse(text)) {
      const le = line.labels.le;
      if (line.name === `${name}_bucket` && le !== undefined) bounds.add(le);
    }
  }
  const buckets = [...bounds]
    .map((le) => ({
      le: le === '+Inf' ? Number.POSITIVE_INFINITY : Number(le),
      count: total(after, `${name}_bucket`, { le }) - total(before, `${name}_bucket`, { le }),
    }))
    .sort((a, b) => a.le - b.le);
  const all = buckets.at(-1)?.count ?? 0;
  if (all === 0) return 0;
  const bucket = buckets.find((candidate) => candidate.count >= quantile * all);
  return (bucket?.le ?? Number.POSITIVE_INFINITY) * 1000;
}
