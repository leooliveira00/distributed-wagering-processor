import { Global, Module } from '@nestjs/common';
import { APP_LOGGER } from '../application/ports/logger';
import { METRICS } from '../application/ports/metrics';
import { PROVIDER_IDENTITY } from '../application/ports/provider-identity';
import { CLOCK, ID_GENERATOR } from '../application/ports/system';
import { AnonymousProviderIdentity } from './auth/anonymous-provider-identity';
import { NestAppLogger } from './observability/nest-app-logger';
import { OperationalGauges } from './observability/operational-gauges';
import { PrometheusMetrics } from './observability/prometheus-metrics';
import { MessagingModule } from './messaging/messaging.module';
import { PersistenceModule } from './persistence/persistence.module';
import { SystemClock, UuidV7IdGenerator } from './system/system.adapters';

/** Binds every application port to its adapter. Swapping an adapter happens only here. */
@Global()
@Module({
  imports: [PersistenceModule, MessagingModule],
  providers: [
    { provide: ID_GENERATOR, useClass: UuidV7IdGenerator },
    { provide: CLOCK, useClass: SystemClock },
    // One registry per process: the port and the /metrics endpoint share the same instance.
    PrometheusMetrics,
    { provide: METRICS, useExisting: PrometheusMetrics },
    OperationalGauges,
    { provide: PROVIDER_IDENTITY, useClass: AnonymousProviderIdentity },
    { provide: APP_LOGGER, useClass: NestAppLogger },
  ],
  exports: [
    PersistenceModule,
    MessagingModule,
    ID_GENERATOR,
    CLOCK,
    METRICS,
    PrometheusMetrics,
    PROVIDER_IDENTITY,
    APP_LOGGER,
  ],
})
export class InfrastructureModule {}
