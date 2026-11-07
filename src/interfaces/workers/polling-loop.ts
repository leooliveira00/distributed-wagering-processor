import { type AppLogger } from '../../application/ports/logger';

/**
 * Runs `tick` repeatedly: immediately again while it reports work done, otherwise after
 * `idleMs`. A failing tick is logged and retried after the idle delay, so one bad iteration never
 * kills the worker. `stop()` interrupts the idle wait and resolves once the current tick ends.
 */
export class PollingLoop {
  private stopping = false;
  private running: Promise<void> | undefined;
  private wake: (() => void) | undefined;

  constructor(
    private readonly name: string,
    private readonly idleMs: number,
    private readonly tick: () => Promise<boolean>,
    private readonly logger: AppLogger,
  ) {}

  start(): void {
    if (this.running) return;
    this.stopping = false;
    this.running = this.loop();
    this.logger.info('Worker started', { worker: this.name });
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.wake?.();
    await this.running;
    this.running = undefined;
    this.logger.info('Worker stopped', { worker: this.name });
  }

  private async loop(): Promise<void> {
    while (!this.isStopping()) {
      let didWork = false;
      try {
        didWork = await this.tick();
      } catch (error) {
        this.logger.error('Worker iteration failed', {
          worker: this.name,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      // `stop()` may have been called while the tick was awaiting.
      if (!didWork && !this.isStopping()) await this.idle();
    }
  }

  /** Read through a method so the compiler does not narrow the field across awaits. */
  private isStopping(): boolean {
    return this.stopping;
  }

  private idle(): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(done, this.idleMs);
      this.wake = done;
      function done(): void {
        clearTimeout(timer);
        resolve();
      }
    });
  }
}
