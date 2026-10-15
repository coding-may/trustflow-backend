import { Module, Global } from '@nestjs/common';
import { TerminusModule } from '@nestjs/terminus';
import { HealthService } from './health.service';
import { MetricsService } from './metrics.service';
import { HealthController } from './health.controller';
import { MetricsHttpInterceptor } from './metrics-http.interceptor';
import { RequestTimeoutInterceptor } from '../common/http/request-timeout.interceptor';
import { DatabaseModule } from '../common/database/database.module';
import { SorobanMetricsService } from './soroban-metrics.service';
import { SorobanRpcMetricsInterceptor } from './soroban-rpc-metrics.interceptor';
import { TracingService } from './tracing.service';
import { DatabaseQueryLoggerService } from './database-query-logger.service';

@Global()
@Module({
  imports: [DatabaseModule, TerminusModule],
  controllers: [HealthController],
  providers: [
    HealthService,
    MetricsService,
    MetricsHttpInterceptor,
    RequestTimeoutInterceptor,
    SorobanMetricsService,
    SorobanRpcMetricsInterceptor,
    TracingService,
    DatabaseQueryLoggerService,
  ],
  exports: [
    HealthService,
    MetricsService,
    MetricsHttpInterceptor,
    RequestTimeoutInterceptor,
    SorobanMetricsService,
    SorobanRpcMetricsInterceptor,
    TracingService,
    DatabaseQueryLoggerService,
  ],
})
export class MonitoringModule {}
