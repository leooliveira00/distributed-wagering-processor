import { Controller, Get, Res } from '@nestjs/common';
import { PrometheusMetrics } from '../../../infrastructure/observability/prometheus-metrics';
import { Public } from '../auth/provider-auth.guard';

interface HeaderResponse {
  setHeader(name: string, value: string): unknown;
}

/**
 * Prometheus scrape endpoint (README §12). Unauthenticated like the health checks: it is meant
 * for the monitoring network, and in production must be reachable only from it (network policy
 * or a separate port). It exposes no ids or money values: labels are low-cardinality by design.
 */
@Public()
@Controller()
export class MetricsController {
  constructor(private readonly metrics: PrometheusMetrics) {}

  @Get('metrics')
  async scrape(@Res({ passthrough: true }) response: HeaderResponse): Promise<string> {
    response.setHeader('Content-Type', this.metrics.registry.contentType);
    return this.metrics.registry.metrics();
  }
}
