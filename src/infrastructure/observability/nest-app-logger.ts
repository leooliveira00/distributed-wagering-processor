import { Logger } from '@nestjs/common';
import { type AppLogger, type LogFields } from '../../application/ports/logger';

/** Adapter over Nest's Logger, which delegates to pino (JSON) once `app.useLogger` is set. */
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
}
