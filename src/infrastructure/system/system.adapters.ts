import { type Clock, type IdGenerator } from '../../application/ports/system';

/**
 * UUIDv7: time-ordered, so new rows land at the end of B-tree indexes instead of at random
 * positions, and ids sort by creation time (same format as the README examples).
 */
export class UuidV7IdGenerator implements IdGenerator {
  next(): string {
    return Bun.randomUUIDv7();
  }
}

export class SystemClock implements Clock {
  now(): Date {
    return new Date();
  }
}
