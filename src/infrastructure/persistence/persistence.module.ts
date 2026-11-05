import { MikroOrmModule } from '@mikro-orm/nestjs';
import { PostgreSqlDriver } from '@mikro-orm/postgresql';
import { Module } from '@nestjs/common';
import { ENV } from '../config/config.module';
import { type Env } from '../config/env';
import { buildMikroOrmConfig } from './mikro-orm.config';

@Module({
  imports: [
    MikroOrmModule.forRootAsync({
      driver: PostgreSqlDriver,
      inject: [ENV],
      useFactory: (env: Env) => ({
        ...buildMikroOrmConfig(env),
        // Every unit of work forks its own EntityManager explicitly; no implicit request context.
        registerRequestContext: false,
      }),
    }),
  ],
})
export class PersistenceModule {}
