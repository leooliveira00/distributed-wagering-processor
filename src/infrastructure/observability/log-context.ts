import { AsyncLocalStorage } from 'node:async_hooks';
import { type ServerResponse } from 'node:http';
import { type LogContext } from '../../application/ports/logger';

/**
 * Ambient log context (README §12): the entry point (HTTP request, SQS message, worker attempt)
 * opens a scope and every log line written inside it, at any depth, carries its fields through
 * pino's `mixin`. Scopes nest (inner fields win) and concurrent scopes never see each other.
 */
const storage = new AsyncLocalStorage<LogContext>();

/**
 * HTTP response -> its request scope. pino-http writes the final request line from the response
 * 'finish'/'close' event, which may fire outside the scope (e.g. the client aborted).
 */
const responseScopes = new WeakMap<object, LogContext>();

function defined(context: LogContext): LogContext {
  return Object.fromEntries(
    Object.entries(context).filter(([, value]) => value !== undefined && value !== ''),
  );
}

export function runWithLogContext<T>(context: LogContext, work: () => T): T {
  return storage.run({ ...storage.getStore(), ...defined(context) }, work);
}

/** Adds fields to the current scope (e.g. transactionId once known). No-op outside a scope. */
export function addToLogContext(context: LogContext): void {
  const scope = storage.getStore();
  if (scope) Object.assign(scope, defined(context));
}

/** A copy of the current scope's fields; empty outside a scope. */
export function currentLogContext(): LogContext {
  return { ...storage.getStore() };
}

/** Links the current scope to the response, so the final request log line carries it too. */
export function bindLogContextToResponse(response: ServerResponse): void {
  const scope = storage.getStore();
  if (scope) responseScopes.set(response, scope);
}

/**
 * Fields for one log line (pino's mixin): the request scope when the line is about a response,
 * then the ambient scope. One object, so no key is ever written twice.
 */
export function logContextFor(mergeObject: object): LogContext {
  const response = (mergeObject as { res?: unknown }).res;
  const requestScope =
    typeof response === 'object' && response !== null ? responseScopes.get(response) : undefined;
  return { ...requestScope, ...storage.getStore() };
}
