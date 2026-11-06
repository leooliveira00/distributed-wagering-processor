import { Global, Module } from '@nestjs/common';
import { METRICS } from '../application/ports/metrics';
import { PROVIDER_IDENTITY } from '../application/ports/provider-identity';
import { CLOCK, ID_GENERATOR } from '../application/ports/system';
import { AnonymousProviderIdentity } from './auth/anonymous-provider-identity';
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
  ],
  exports: [PersistenceModule, ID_GENERATOR, CLOCK, METRICS, PROVIDER_IDENTITY],
})
export class InfrastructureModule {}
