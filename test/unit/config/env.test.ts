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

  it('bounds database connections and silent queries on the client side by default', () => {
    const env = loadEnv({});

    expect(env.DATABASE_CONNECT_TIMEOUT_MS).toBe(5_000);
    expect(env.DATABASE_QUERY_TIMEOUT_MS).toBeGreaterThan(env.DATABASE_STATEMENT_TIMEOUT_MS);
  });

  it.each([
    ['equal to', '15000'],
    ['below', '10000'],
  ])('rejects a client query timeout %s the statement timeout', (_, queryTimeout) => {
    expect(() =>
      loadEnv({ DATABASE_STATEMENT_TIMEOUT_MS: '15000', DATABASE_QUERY_TIMEOUT_MS: queryTimeout }),
    ).toThrow(InvalidEnvironmentError);
  });

  it('bounds every SQS call by default, above the long-poll wait', () => {
    const env = loadEnv({});

    expect(env.SQS_CONNECT_TIMEOUT_MS).toBe(3_000);
    expect(env.SQS_REQUEST_TIMEOUT_MS).toBeGreaterThan(env.SQS_CONSUMER_WAIT_TIME_SECONDS * 1_000);
  });

  it('rejects an SQS request timeout that would cut a long poll short', () => {
    expect(() =>
      loadEnv({ SQS_CONSUMER_WAIT_TIME_SECONDS: '20', SQS_REQUEST_TIMEOUT_MS: '20000' }),
    ).toThrow(InvalidEnvironmentError);
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
