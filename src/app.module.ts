import { Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { ConfigModule } from './infrastructure/config/config.module';
import { InfrastructureModule } from './infrastructure/infrastructure.module';
import { LoggerModule } from './infrastructure/observability/logger.module';
import { ProviderAuthGuard } from './interfaces/http/auth/provider-auth.guard';
import { HttpErrorFilter } from './interfaces/http/errors/http-error.filter';
import { HealthController } from './interfaces/http/health/health.controller';
import { WalletsModule } from './interfaces/http/wallets/wallets.module';

@Module({
  imports: [ConfigModule, LoggerModule, InfrastructureModule, WalletsModule],
  controllers: [HealthController],
  providers: [
    { provide: APP_FILTER, useClass: HttpErrorFilter },
    { provide: APP_GUARD, useClass: ProviderAuthGuard },
  ],
})
export class AppModule {}
