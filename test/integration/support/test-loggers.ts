import {
  type AppLogger,
  type LogContext,
  type LogFields,
} from '../../../src/application/ports/logger';
import {
  addToLogContext,
  currentLogContext,
  runWithLogContext,
} from '../../../src/infrastructure/observability/log-context';

export interface LogLine {
  level: 'info' | 'warn' | 'error';
  message: string;
  fields: LogFields;
  /** The ambient context the line was written in, as pino's mixin would add it. */
  context: LogContext;
}

/** Records every line with its ambient context; scopes are the real AsyncLocalStorage ones. */
export class RecordingLogger implements AppLogger {
  readonly lines: LogLine[] = [];

  get warnings(): LogLine[] {
    return this.lines.filter((line) => line.level === 'warn');
  }

  info(message: string, fields: LogFields = {}): void {
    this.record('info', message, fields);
  }

  warn(message: string, fields: LogFields = {}): void {
    this.record('warn', message, fields);
  }

  error(message: string, fields: LogFields = {}): void {
    this.record('error', message, fields);
  }

  withContext<T>(context: LogContext, work: () => Promise<T>): Promise<T> {
    return runWithLogContext(context, work);
  }

  addContext(context: LogContext): void {
    addToLogContext(context);
  }

  private record(level: LogLine['level'], message: string, fields: LogFields): void {
    this.lines.push({ level, message, fields, context: currentLogContext() });
  }
}

export const silentLogger: AppLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  withContext: (_context, work) => work(),
  addContext: () => undefined,
};
