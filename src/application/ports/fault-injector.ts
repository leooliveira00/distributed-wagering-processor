/**
 * Named points where tests can make the process die, to prove recovery (README §11, §13).
 * The production adapter is configured from FAULT_INJECTION and does nothing when it is empty.
 */
export type FaultPoint = 'outbox:after-claim' | 'outbox:after-publish' | 'consumer:after-commit';

export interface FaultInjector {
  trigger(point: FaultPoint): void;
}

export const FAULT_INJECTOR = Symbol('FAULT_INJECTOR');
