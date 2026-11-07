import { Module } from '@nestjs/common';
import { LoggerModule as PinoLoggerModule } from 'nestjs-pino';
import { type Env } from '../config/env';
import { ENV } from '../config/config.module';
import { buildPinoHttpOptions } from './pino-options';

@Module({
  imports: [
    PinoLoggerModule.forRootAsync({
      inject: [ENV],
      useFactory: (env: Env) => ({ pinoHttp: buildPinoHttpOptions(env) }),
    }),
  ],
})
export class LoggerModule {}
