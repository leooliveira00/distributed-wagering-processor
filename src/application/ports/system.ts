/** Source of new identifiers. The domain receives ids as parameters and stays deterministic. */
export interface IdGenerator {
  next(): string;
}

/** Source of the current time, replaceable in tests. */
export interface Clock {
  now(): Date;
}

export const ID_GENERATOR = Symbol('ID_GENERATOR');
export const CLOCK = Symbol('CLOCK');
