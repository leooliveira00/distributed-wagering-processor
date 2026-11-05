import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module';
import { ENV } from './infrastructure/config/config.module';
import { type Env } from './infrastructure/config/env';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  app.useLogger(app.get(Logger));
  app.enableShutdownHooks();

  const env = app.get<Env>(ENV);
  await app.listen(env.PORT);
  app.get(Logger).log(`HTTP server listening on port ${env.PORT}`, 'Bootstrap');
}

await bootstrap();
