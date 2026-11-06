import { type IdGenerator } from '../../application/ports/system';
import { type RequestContext } from '../../application/shared/request-context';
import { isSafeCorrelationId } from '../contracts/wager-contract';

export const CORRELATION_HEADER = 'x-correlation-id';

/** Uses the caller's correlation id when it is well-formed; otherwise starts a new one. */
export function requestContextFrom(
  headers: Record<string, string | string[] | undefined>,
  ids: IdGenerator,
): RequestContext {
  const header = headers[CORRELATION_HEADER];
  return { correlationId: isSafeCorrelationId(header) ? header : ids.next() };
}
