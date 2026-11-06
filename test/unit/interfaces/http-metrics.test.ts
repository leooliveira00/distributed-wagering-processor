import { describe, expect, it } from 'bun:test';
import { type IncomingMessage } from 'node:http';
import { routeOf } from '../../../src/interfaces/http/http-metrics.middleware';

const request = (route?: unknown, baseUrl?: unknown) =>
  ({ route, baseUrl }) as unknown as IncomingMessage & { route?: { path?: unknown } };

describe('routeOf', () => {
  it('uses the route template, never the concrete URL', () => {
    expect(routeOf(request({ path: '/wallets/:walletId' }))).toBe('/wallets/:walletId');
  });

  it('prefixes the router base path', () => {
    expect(routeOf(request({ path: '/:walletId' }, '/wallets'))).toBe('/wallets/:walletId');
  });

  it.each([
    ['no matched route', undefined],
    ['a route without a path', {}],
    ["Nest's catch-all 404 route", { path: '{/*splat}' }],
  ])('maps %s to "unmatched"', (_, route) => {
    expect(routeOf(request(route))).toBe('unmatched');
  });
});
