import { Logger } from '@nestjs/common';
import { type AppLogger, type LogContext, type LogFields } from '../../application/ports/logger';
import { addToLogContext, runWithLogContext } from './log-context';

/**
 * Adapter over Nest's Logger, which delegates to pino (JSON) once `app.useLogger` is set. The
 * context fields are added by pino's mixin, so they reach every line, not only these.
 */
export class NestAppLogger implements AppLogger {
  private readonly logger = new Logger('Application');

  info(message: string, fields: LogFields = {}): void {
    this.logger.log({ ...fields, msg: message });
  }

  warn(message: string, fields: LogFields = {}): void {
    this.logger.warn({ ...fields, msg: message });
  }

  error(message: string, fields: LogFields = {}): void {
    this.logger.error({ ...fields, msg: message });
  }

  withContext<T>(context: LogContext, work: () => Promise<T>): Promise<T> {
    return runWithLogContext(context, work);
  }

  addContext(context: LogContext): void {
    addToLogContext(context);
  }
}
