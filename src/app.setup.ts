import { type INestApplication } from '@nestjs/common';
import { Logger } from 'nestjs-pino';

/** Application-level configuration shared by `main.ts` and the HTTP integration tests. */
export function configureApp(app: INestApplication): void {
  app.useLogger(app.get(Logger));
  app.enableShutdownHooks();
}
