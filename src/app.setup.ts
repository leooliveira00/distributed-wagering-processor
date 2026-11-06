import { type INestApplication } from '@nestjs/common';
import { Logger } from 'nestjs-pino';
import { APP_LOGGER, type AppLogger } from './application/ports/logger';
import { ID_GENERATOR, type IdGenerator } from './application/ports/system';
import { LogContextInterceptor } from './interfaces/http/log-context.interceptor';
import { logContextMiddleware } from './interfaces/http/log-context.middleware';

/** Application-level configuration shared by `main.ts` and the HTTP integration tests. */
export function configureApp(app: INestApplication): void {
  app.useLogger(app.get(Logger));
  // Registered before the routes, so the log scope wraps the whole request (README §12).
  app.use(logContextMiddleware(app.get<IdGenerator>(ID_GENERATOR)));
  app.useGlobalInterceptors(new LogContextInterceptor(app.get<AppLogger>(APP_LOGGER)));
  app.enableShutdownHooks();
}
