import { Controller, Get } from '@nestjs/common';
import { Public } from '../auth/provider-auth.guard';

export interface LivenessResponse {
  status: 'ok';
  uptimeSeconds: number;
}

/**
 * Health endpoints are intentionally unauthenticated (README §2).
 * Readiness (PostgreSQL + SQS) is added together with observability.
 */
@Public()
@Controller('health')
export class HealthController {
  @Get('live')
  live(): LivenessResponse {
    return { status: 'ok', uptimeSeconds: Math.floor(process.uptime()) };
  }
}
