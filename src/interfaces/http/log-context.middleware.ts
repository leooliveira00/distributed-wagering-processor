import { type IncomingMessage, type ServerResponse } from 'node:http';
import { type IdGenerator } from '../../application/ports/system';
import {
  bindLogContextToResponse,
  runWithLogContext,
} from '../../infrastructure/observability/log-context';
import { isSafeCorrelationId } from '../contracts/wager-contract';
import { CORRELATION_HEADER } from './request-context';

/**
 * First thing every request goes through: settles its correlation id (the caller's, when it is
 * well-formed, otherwise a new one), echoes it in `X-Correlation-Id`, and opens the log scope the
 * whole request runs in. The header is normalized in place so controllers read the same id.
 */
export function logContextMiddleware(ids: IdGenerator) {
  return (request: IncomingMessage, response: ServerResponse, next: () => void): void => {
    const header = request.headers[CORRELATION_HEADER];
    const correlationId = isSafeCorrelationId(header) ? header : ids.next();
    request.headers[CORRELATION_HEADER] = correlationId;
    response.setHeader('X-Correlation-Id', correlationId);
    runWithLogContext({ correlationId }, () => {
      bindLogContextToResponse(response);
      next();
    });
  };
}
