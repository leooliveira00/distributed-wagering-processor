/**
 * Every random choice of a resilience run (kill point, victim, operation order) comes from one
 * seed, printed at the start. A failing run is replayed with `RESILIENCE_SEED=<seed> bun test …`.
 * Timing still varies between runs; the seed fixes what the test decides, not the scheduler.
 */
export interface SeededRandom {
  readonly seed: number;
  /** Uniform in [0, 1). */
  next(): number;
  /** Uniform integer in [0, max). */
  int(max: number): number;
  /** Fisher-Yates: a uniformly shuffled copy. */
  shuffle<T>(items: readonly T[]): T[];
}

export function seededRandom(suite: string): SeededRandom {
  const fromEnv = Number.parseInt(process.env.RESILIENCE_SEED ?? '', 10);
  const seed = Number.isInteger(fromEnv) ? fromEnv >>> 0 : (Math.random() * 2 ** 32) >>> 0;
  console.info(`[${suite}] RESILIENCE_SEED=${String(seed)}`);

  // mulberry32: tiny, fast and good enough to drive test decisions.
  let state = seed;
  const next = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 2 ** 32;
  };
  const int = (max: number) => Math.floor(next() * max);
  return {
    seed,
    next,
    int,
    shuffle<T>(items: readonly T[]): T[] {
      const copy = [...items];
      for (let index = copy.length - 1; index > 0; index--) {
        const other = int(index + 1);
        [copy[index], copy[other]] = [copy[other] as T, copy[index] as T];
      }
      return copy;
    },
  };
}
