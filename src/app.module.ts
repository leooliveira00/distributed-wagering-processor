import { Module } from '@nestjs/common';
import { ConfigModule } from './infrastructure/config/config.module';
import { LoggerModule } from './infrastructure/observability/logger.module';
import { PersistenceModule } from './infrastructure/persistence/persistence.module';
import { HealthController } from './interfaces/http/health/health.controller';

@Module({
  imports: [ConfigModule, LoggerModule, PersistenceModule],
  controllers: [HealthController],
})
export class AppModule {}
