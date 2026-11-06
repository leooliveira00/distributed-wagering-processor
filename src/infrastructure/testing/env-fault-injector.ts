import { type FaultInjector, type FaultPoint } from '../../application/ports/fault-injector';

/**
 * Kills the process abruptly at configured points (FAULT_INJECTION). No shutdown hooks run, no
 * in-flight work completes: the closest thing to a power cut, used by the resilience tests.
 * With FAULT_INJECTION empty (production) every call is a no-op.
 */
export class EnvFaultInjector implements FaultInjector {
  private readonly points: ReadonlySet<FaultPoint>;

  constructor(points: readonly FaultPoint[]) {
    this.points = new Set(points);
  }

  trigger(point: FaultPoint): void {
    if (!this.points.has(point)) return;
    process.stderr.write(`[fault-injection] crashing at ${point}\n`);
    process.kill(process.pid, 'SIGKILL');
    process.exit(137); // in case the platform ignored the signal
  }
}
