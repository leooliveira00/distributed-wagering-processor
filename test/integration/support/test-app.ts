import { type INestApplication } from '@nestjs/common';
import { type NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { type AddressInfo } from 'node:net';
import { AppModule } from '../../../src/app.module';
import { configureApp } from '../../../src/app.setup';
import { ENV } from '../../../src/infrastructure/config/config.module';
import { type TestDatabase } from './test-database';

export interface TestApp {
  app: INestApplication;
  baseUrl: string;
  request(
    method: string,
    path: string,
    body?: unknown,
    headers?: Record<string, string>,
  ): Promise<TestResponse>;
  close(): Promise<void>;
}

export interface TestResponse {
  status: number;
  headers: Headers;
  body: unknown;
}

/**
 * Boots the real application (all modules, filters, guards) on a random port against the
 * suite's disposable database, and talks to it over real HTTP.
 */
export async function createTestApp(
  db: TestDatabase,
  overrides: readonly { token: symbol; value: unknown }[] = [],
): Promise<TestApp> {
  let builder = Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(ENV)
    .useValue(db.env);
  for (const { token, value } of overrides) {
    builder = builder.overrideProvider(token).useValue(value);
  }
  const moduleRef = await builder.compile();

  const app = moduleRef.createNestApplication<NestExpressApplication>({ bufferLogs: true });
  configureApp(app);
  await app.listen(0, '127.0.0.1');
  const { port } = (app.getHttpServer() as { address(): AddressInfo }).address();
  const baseUrl = `http://127.0.0.1:${String(port)}`;

  return {
    app,
    baseUrl,
    async request(method, path, body, headers = {}) {
      const response = await fetch(`${baseUrl}${path}`, {
        method,
        headers: {
          ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
          ...headers,
        },
        ...(body !== undefined
          ? { body: typeof body === 'string' ? body : JSON.stringify(body) }
          : {}),
      });
      const text = await response.text();
      return {
        status: response.status,
        headers: response.headers,
        body: text.length > 0 ? (JSON.parse(text) as unknown) : undefined,
      };
    },
    async close() {
      await app.close();
    },
  };
}
