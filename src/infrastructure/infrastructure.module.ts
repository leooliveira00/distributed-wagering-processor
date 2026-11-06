import { Global, Module } from '@nestjs/common';
import { APP_LOGGER } from '../application/ports/logger';
import { METRICS } from '../application/ports/metrics';
import { PROVIDER_IDENTITY } from '../application/ports/provider-identity';
import { CLOCK, ID_GENERATOR } from '../application/ports/system';
import { AnonymousProviderIdentity } from './auth/anonymous-provider-identity';
import { NestAppLogger } from './observability/nest-app-logger';
import { PrometheusMetrics } from './observability/prometheus-metrics';
import { PersistenceModule } from './persistence/persistence.module';
import { SystemClock, UuidV7IdGenerator } from './system/system.adapters';

/** Binds every application port to its adapter. Swapping an adapter happens only here. */
@Global()
@Module({
  imports: [PersistenceModule],
  providers: [
    { provide: ID_GENERATOR, useClass: UuidV7IdGenerator },
    { provide: CLOCK, useClass: SystemClock },
    { provide: METRICS, useClass: PrometheusMetrics },
    { provide: PROVIDER_IDENTITY, useClass: AnonymousProviderIdentity },
    { provide: APP_LOGGER, useClass: NestAppLogger },
  ],
  exports: [PersistenceModule, ID_GENERATOR, CLOCK, METRICS, PROVIDER_IDENTITY, APP_LOGGER],
})
export class InfrastructureModule {}
