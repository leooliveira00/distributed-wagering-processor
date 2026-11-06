import { describe, expect, it } from 'bun:test';
import {
  APP_ROLES,
  InvalidEnvironmentError,
  loadEnv,
} from '../../../src/infrastructure/config/env';

describe('loadEnv', () => {
  it('applies defaults for local development', () => {
    const env = loadEnv({});

    expect(env.NODE_ENV).toBe('development');
    expect(env.PORT).toBe(3000);
    expect(env.APP_ROLES).toEqual([...APP_ROLES]);
    expect(env.SQS_WAGER_QUEUE_NAME).toBe('wager-transactions.fifo');
    expect(env.AWS_ENDPOINT_URL).toBeUndefined();
  });

  it('parses, trims and deduplicates APP_ROLES', () => {
    const env = loadEnv({ APP_ROLES: ' api , outbox,api,' });

    expect(env.APP_ROLES).toEqual(['api', 'outbox']);
  });

  it('coerces numeric variables', () => {
    const env = loadEnv({ PORT: '8080', DATABASE_POOL_MAX: '5' });

    expect(env.PORT).toBe(8080);
    expect(env.DATABASE_POOL_MAX).toBe(5);
  });

  it.each([
    ['unknown role', { APP_ROLES: 'api,admin' }],
    ['empty role list', { APP_ROLES: ' , ' }],
    ['non-numeric port', { PORT: 'abc' }],
    ['port out of range', { PORT: '70000' }],
    ['non-FIFO wager queue', { SQS_WAGER_QUEUE_NAME: 'wager-transactions' }],
    ['invalid endpoint URL', { AWS_ENDPOINT_URL: 'not a url' }],
  ])('rejects %s', (_, source) => {
    expect(() => loadEnv(source)).toThrow(InvalidEnvironmentError);
  });

  it('parses fault injection points for test environments', () => {
    const env = loadEnv({
      NODE_ENV: 'test',
      FAULT_INJECTION: 'outbox:after-claim, outbox:after-publish',
    });

    expect(env.FAULT_INJECTION).toEqual(['outbox:after-claim', 'outbox:after-publish']);
  });

  it('rejects an unknown fault injection point', () => {
    expect(() => loadEnv({ FAULT_INJECTION: 'outbox:somewhere' })).toThrow(InvalidEnvironmentError);
  });

  it('refuses to arm fault injection in production', () => {
    expect(() =>
      loadEnv({ NODE_ENV: 'production', FAULT_INJECTION: 'outbox:after-claim' }),
    ).toThrow(InvalidEnvironmentError);
    expect(loadEnv({ NODE_ENV: 'production' }).FAULT_INJECTION).toEqual([]);
  });

  it('reports every invalid variable at once', () => {
    try {
      loadEnv({ PORT: 'abc', APP_ROLES: 'admin' });
      throw new Error('expected loadEnv to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(InvalidEnvironmentError);
      expect((error as InvalidEnvironmentError).issues).toHaveLength(2);
    }
  });
});
