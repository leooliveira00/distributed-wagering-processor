import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module';
import { configureApp } from './app.setup';
import { ENV } from './infrastructure/config/config.module';
import { type Env } from './infrastructure/config/env';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  configureApp(app);

  const env = app.get<Env>(ENV);
  await app.listen(env.PORT);
  app.get(Logger).log(`HTTP server listening on port ${String(env.PORT)}`, 'Bootstrap');
}

await bootstrap();
