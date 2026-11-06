import {
  type CallHandler,
  type ExecutionContext,
  Inject,
  Injectable,
  type NestInterceptor,
} from '@nestjs/common';
import { type Observable, tap } from 'rxjs';
import { APP_LOGGER, type AppLogger, type LogContext } from '../../application/ports/logger';

const CONTEXT_KEYS = ['transactionId', 'walletId', 'providerId'] as const;

/** Visible ASCII only and bounded: values come from the request before validation. */
const SAFE_VALUE = /^[\x21-\x7E]{1,128}$/;

function contextOf(source: unknown): LogContext {
  if (typeof source !== 'object' || source === null) return {};
  const record = source as Record<string, unknown>;
  const context: LogContext = {};
  for (const key of CONTEXT_KEYS) {
    const value = record[key];
    if (typeof value === 'string' && SAFE_VALUE.test(value)) context[key] = value;
  }
  return context;
}

/**
 * Adds the ids a request is about to its log scope: from the route and the body on the way in
 * (`walletId`, `providerId`, `transactionId`), and from the response on the way out (e.g. the
 * `transactionId` of a new submission), in time for the final request log line.
 */
@Injectable()
export class LogContextInterceptor implements NestInterceptor {
  constructor(@Inject(APP_LOGGER) private readonly logger: AppLogger) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const request = context.switchToHttp().getRequest<{ params?: unknown; body?: unknown }>();
    this.logger.addContext({ ...contextOf(request.body), ...contextOf(request.params) });
    return next.handle().pipe(
      tap((response) => {
        this.logger.addContext(contextOf(response));
      }),
    );
  }
}
