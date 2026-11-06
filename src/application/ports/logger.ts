/** Structured fields attached to a log line. Never put full financial payloads here. */
export type LogFields = Readonly<Record<string, string | number | boolean | undefined>>;

/** Structured logging port, so use cases log without depending on the framework. */
export interface AppLogger {
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
}

export const APP_LOGGER = Symbol('APP_LOGGER');
