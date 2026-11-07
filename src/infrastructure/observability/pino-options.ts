import { type Options } from 'pino-http';
import { type Env } from '../config/env';
import { logContextFor } from './log-context';

/**
 * Never logged (README §12): credentials, and anything that may carry a full financial payload
 * or money values. Logs say WHICH transaction/wallet, never HOW MUCH. Wildcards cover one level
 * of nesting, as defense in depth: code is not supposed to log these in the first place.
 */
export const REDACTED_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.body',
  'res.body',
  'payload',
  'data',
  'money',
  '*.money',
  'amount',
  '*.amount',
  'balance',
  '*.balance',
  'initialBalance',
  '*.initialBalance',
  'observedBalance',
  '*.observedBalance',
];

export function buildPinoHttpOptions(env: Env): Options {
  return {
    level: env.LOG_LEVEL,
    base: { service: 'distributed-wagering-processor', roles: env.APP_ROLES },
    messageKey: 'message',
    timestamp: () => `,"time":"${new Date().toISOString()}"`,
    redact: { paths: REDACTED_PATHS, censor: '[REDACTED]' },
    // The single source of context fields (no customProps: it would bind them a second time).
    // Every line written inside a scope carries them; explicit fields of a line win.
    mixin: (mergeObject) => ({ ...logContextFor(mergeObject) }),
    // Probes and scrapes run every few seconds: logging each one would drown the real traffic.
    autoLogging: {
      ignore: (req) => (req.url?.startsWith('/health') ?? false) || req.url === '/metrics',
    },
  };
}
