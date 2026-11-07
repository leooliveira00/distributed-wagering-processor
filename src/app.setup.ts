import { type NestExpressApplication } from '@nestjs/platform-express';
import { Logger } from 'nestjs-pino';
import { APP_LOGGER, type AppLogger } from './application/ports/logger';
import { METRICS, type Metrics } from './application/ports/metrics';
import { ID_GENERATOR, type IdGenerator } from './application/ports/system';
import { httpMetricsMiddleware } from './interfaces/http/http-metrics.middleware';
import { LogContextInterceptor } from './interfaces/http/log-context.interceptor';
import { logContextMiddleware } from './interfaces/http/log-context.middleware';

/** Application-level configuration shared by `main.ts` and the HTTP integration tests. */
export function configureApp(app: NestExpressApplication): void {
  // Express announces itself in every response by default: no reason to tell a client (or an
  // attacker fingerprinting the stack) which framework and version to look up.
  app.disable('x-powered-by');
  app.useLogger(app.get(Logger));
  // Registered before the routes, so the log scope wraps the whole request (README §12).
  app.use(logContextMiddleware(app.get<IdGenerator>(ID_GENERATOR)));
  app.use(httpMetricsMiddleware(app.get<Metrics>(METRICS)));
  app.useGlobalInterceptors(new LogContextInterceptor(app.get<AppLogger>(APP_LOGGER)));
  app.enableShutdownHooks();
}
