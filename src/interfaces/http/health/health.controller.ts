import { Controller, Get, HttpStatus, Res } from '@nestjs/common';
import {
  ReadinessProbe,
  type ReadinessReport,
} from '../../../infrastructure/health/readiness-probe';
import { Public } from '../auth/provider-auth.guard';

export interface LivenessResponse {
  status: 'ok';
  uptimeSeconds: number;
}

interface StatusResponse {
  status(code: number): unknown;
}

/**
 * Health endpoints are intentionally unauthenticated (README §2). Liveness says the process is
 * running (restart it if not); readiness says it can serve traffic (stop routing to it if not).
 * Liveness never checks dependencies: a database outage must not make every instance restart.
 */
@Public()
@Controller('health')
export class HealthController {
  constructor(private readonly readiness: ReadinessProbe) {}

  @Get('live')
  live(): LivenessResponse {
    return { status: 'ok', uptimeSeconds: Math.floor(process.uptime()) };
  }

  /** 200 when PostgreSQL and SQS are reachable, 503 otherwise (README §8). */
  @Get('ready')
  async ready(@Res({ passthrough: true }) response: StatusResponse): Promise<ReadinessReport> {
    const report = await this.readiness.check();
    response.status(report.status === 'ok' ? HttpStatus.OK : HttpStatus.SERVICE_UNAVAILABLE);
    return report;
  }
}
