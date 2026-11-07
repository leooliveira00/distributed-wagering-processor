import { MikroOrmModule } from '@mikro-orm/nestjs';
import { MikroORM, PostgreSqlDriver } from '@mikro-orm/postgresql';
import { Module } from '@nestjs/common';
import { METRICS, type Metrics } from '../../application/ports/metrics';
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
      inject: [MikroORM, METRICS],
      useFactory: (orm: MikroORM, metrics: Metrics): UnitOfWork =>
        new MikroOrmUnitOfWork(orm, metrics),
    },
  ],
  exports: [UNIT_OF_WORK],
})
export class PersistenceModule {}
