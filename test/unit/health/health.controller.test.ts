import { describe, expect, it } from 'bun:test';
import {
  type ReadinessProbe,
  type ReadinessReport,
} from '../../../src/infrastructure/health/readiness-probe';
import { HealthController } from '../../../src/interfaces/http/health/health.controller';

const probeReturning = (report: ReadinessReport) =>
  ({ check: () => Promise.resolve(report) }) as unknown as ReadinessProbe;

const untouchableProbe = {
  check: () => {
    throw new Error('liveness must not check dependencies');
  },
} as unknown as ReadinessProbe;

function statusRecorder() {
  const recorded: { code?: number } = {};
  return { recorded, response: { status: (code: number) => (recorded.code = code) } };
}

describe('HealthController', () => {
  it('reports liveness without touching external dependencies', () => {
    const response = new HealthController(untouchableProbe).live();

    expect(response.status).toBe('ok');
    expect(response.uptimeSeconds).toBeGreaterThanOrEqual(0);
  });

  it('answers 200 when every dependency is up', async () => {
    const report: ReadinessReport = {
      status: 'ok',
      checks: { postgres: { status: 'up', latencyMs: 1 }, sqs: { status: 'up', latencyMs: 2 } },
    };
    const { recorded, response } = statusRecorder();

    expect(await new HealthController(probeReturning(report)).ready(response)).toEqual(report);
    expect(recorded.code).toBe(200);
  });

  it('answers 503 when any dependency is down', async () => {
    const report: ReadinessReport = {
      status: 'unavailable',
      checks: {
        postgres: { status: 'up', latencyMs: 1 },
        sqs: { status: 'down', latencyMs: 2000 },
      },
    };
    const { recorded, response } = statusRecorder();

    await new HealthController(probeReturning(report)).ready(response);
    expect(recorded.code).toBe(503);
  });
});
