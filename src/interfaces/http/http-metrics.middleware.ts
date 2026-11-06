import { type IncomingMessage, type ServerResponse } from 'node:http';
import { type Metrics } from '../../application/ports/metrics';

/** What Express adds to the request once a route matched. */
interface RoutedRequest extends IncomingMessage {
  route?: { path?: unknown };
  baseUrl?: unknown;
}

/**
 * The route TEMPLATE (`/wallets/:walletId`), never the concrete URL: one series per endpoint.
 * Anything that matched no route is `unmatched`, so random URLs cannot create new series;
 * that includes Nest's catch-all 404 route (`{/*splat}`), a wildcard template.
 */
export function routeOf(request: RoutedRequest): string {
  const path = request.route?.path;
  if (typeof path !== 'string' || path.includes('*')) return 'unmatched';
  const base = typeof request.baseUrl === 'string' ? request.baseUrl : '';
  return `${base}${path}`;
}

/** Records `http_request_duration_seconds` when each response finishes (README §12). */
export function httpMetricsMiddleware(metrics: Metrics) {
  return (request: RoutedRequest, response: ServerResponse, next: () => void): void => {
    // The scrape itself is not traffic worth measuring.
    if (request.url === '/metrics') {
      next();
      return;
    }
    const started = performance.now();
    response.once('finish', () => {
      metrics.observe('http_request_duration_seconds', (performance.now() - started) / 1000, {
        method: request.method ?? 'UNKNOWN',
        route: routeOf(request),
        status: String(response.statusCode),
      });
    });
    next();
  };
}
