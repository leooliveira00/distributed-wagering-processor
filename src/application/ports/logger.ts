/** Structured fields attached to a log line. Never put full financial payloads here. */
export type LogFields = Readonly<Record<string, string | number | boolean | undefined>>;

/** Tracing fields every log line of an operation carries (README §12). */
export interface LogContext {
  correlationId?: string | undefined;
  messageId?: string | undefined;
  transactionId?: string | undefined;
  walletId?: string | undefined;
  providerId?: string | undefined;
}

/** Structured logging port, so use cases log without depending on the framework. */
export interface AppLogger {
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
  /** Runs `work` in a nested scope: every line logged inside it carries `context`. */
  withContext<T>(context: LogContext, work: () => Promise<T>): Promise<T>;
  /** Adds fields to the current scope, e.g. the transaction id once it is known. */
  addContext(context: LogContext): void;
}

export const APP_LOGGER = Symbol('APP_LOGGER');
