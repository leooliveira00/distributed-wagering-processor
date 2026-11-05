import { Module } from '@nestjs/common';
import { LoggerModule as PinoLoggerModule } from 'nestjs-pino';
import { type Env } from '../config/env';
import { ENV } from '../config/config.module';

// Paths that may carry credentials or full financial payloads must never reach the logs.
const REDACTED_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.body',
  'res.body',
  'payload',
  'data',
];

@Module({
  imports: [
    PinoLoggerModule.forRootAsync({
      inject: [ENV],
      useFactory: (env: Env) => ({
        pinoHttp: {
          level: env.LOG_LEVEL,
          base: { service: 'distributed-wagering-processor', roles: env.APP_ROLES },
          messageKey: 'message',
          timestamp: () => `,"time":"${new Date().toISOString()}"`,
          redact: { paths: REDACTED_PATHS, censor: '[REDACTED]' },
          autoLogging: { ignore: (req) => req.url?.startsWith('/health') ?? false },
        },
      }),
    }),
  ],
})
export class LoggerModule {}
