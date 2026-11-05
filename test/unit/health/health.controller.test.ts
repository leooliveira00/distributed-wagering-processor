import { describe, expect, it } from 'bun:test';
import { HealthController } from '../../../src/interfaces/http/health/health.controller';

describe('HealthController', () => {
  it('reports liveness without touching external dependencies', () => {
    const response = new HealthController().live();

    expect(response.status).toBe('ok');
    expect(response.uptimeSeconds).toBeGreaterThanOrEqual(0);
  });
});
