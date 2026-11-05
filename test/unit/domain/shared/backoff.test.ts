import { describe, expect, it } from 'bun:test';
import { backoffDelayMs, nextAttemptAt } from '../../../../src/domain/shared/backoff';

const policy = { baseMs: 1_000, capMs: 60_000 };

describe('backoffDelayMs', () => {
  it('doubles the delay on each attempt', () => {
    expect([1, 2, 3, 4, 5].map((attempt) => backoffDelayMs(attempt, policy))).toEqual([
      1_000, 2_000, 4_000, 8_000, 16_000,
    ]);
  });

  it('never exceeds the cap', () => {
    expect(backoffDelayMs(7, policy)).toBe(60_000);
    expect(backoffDelayMs(10_000, policy)).toBe(60_000);
  });

  it('is deterministic', () => {
    expect(backoffDelayMs(3, policy)).toBe(backoffDelayMs(3, policy));
  });

  it.each([0, -1, 1.5, Number.NaN])('rejects attempt %p', (attempt) => {
    expect(() => backoffDelayMs(attempt, policy)).toThrow(RangeError);
  });

  it.each([
    ['zero base', { baseMs: 0, capMs: 10 }],
    ['cap below base', { baseMs: 10, capMs: 5 }],
  ])('rejects a policy with %s', (_, invalid) => {
    expect(() => backoffDelayMs(1, invalid)).toThrow(RangeError);
  });
});

describe('nextAttemptAt', () => {
  it('adds the delay to now', () => {
    const now = new Date('2026-11-05T12:00:00.000Z');

    expect(nextAttemptAt(now, 3, policy).toISOString()).toBe('2026-11-05T12:00:04.000Z');
  });
});
