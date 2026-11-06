import { type IdGenerator } from '../../application/ports/system';
import { type RequestContext } from '../../application/shared/request-context';

export const CORRELATION_HEADER = 'x-correlation-id';
const CORRELATION_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

/** Uses the caller's correlation id when it is well-formed; otherwise starts a new one. */
export function requestContextFrom(
  headers: Record<string, string | string[] | undefined>,
  ids: IdGenerator,
): RequestContext {
  const header = headers[CORRELATION_HEADER];
  const correlationId =
    typeof header === 'string' && CORRELATION_PATTERN.test(header) ? header : ids.next();
  return { correlationId };
}
