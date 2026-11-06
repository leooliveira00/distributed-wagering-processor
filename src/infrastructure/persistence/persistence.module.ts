import { MikroORM } from '@mikro-orm/core';
import { MikroOrmModule } from '@mikro-orm/nestjs';
import { PostgreSqlDriver } from '@mikro-orm/postgresql';
import { Module } from '@nestjs/common';
import { UNIT_OF_WORK, type UnitOfWork } from '../../application/ports/unit-of-work';
import { ENV } from '../config/config.module';
import { type Env } from '../config/env';
import { buildMikroOrmConfig } from './mikro-orm.config';
import { MikroOrmUnitOfWork } from './mikro-orm-unit-of-work';

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
  providers: [
    {
      provide: UNIT_OF_WORK,
      inject: [MikroORM],
      useFactory: (orm: MikroORM): UnitOfWork => new MikroOrmUnitOfWork(orm),
    },
  ],
  exports: [UNIT_OF_WORK],
})
export class PersistenceModule {}
