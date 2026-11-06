import { describe, expect, it } from 'bun:test';
import pino from 'pino';
import { loadEnv } from '../../../src/infrastructure/config/env';
import { IncomingMessage, ServerResponse } from 'node:http';
import { Socket } from 'node:net';
import {
  bindLogContextToResponse,
  runWithLogContext,
} from '../../../src/infrastructure/observability/log-context';
import { buildPinoHttpOptions } from '../../../src/infrastructure/observability/pino-options';

/** A pino logger with the application options, writing JSON lines to memory. */
function capture() {
  const lines: Record<string, unknown>[] = [];
  const raw: string[] = [];
  const { level, base, messageKey, timestamp, redact, mixin } = buildPinoHttpOptions(
    loadEnv({ LOG_LEVEL: 'info' }),
  );
  const logger = pino(
    {
      level,
      base,
      messageKey,
      timestamp,
      redact,
      mixin,
      serializers: { res: pino.stdSerializers.res },
    },
    {
      write: (line: string) => {
        raw.push(line);
        lines.push(JSON.parse(line) as Record<string, unknown>);
      },
    },
  );
  return { logger, lines, raw };
}

describe('pino options', () => {
  it('writes JSON lines with service, time and message', () => {
    const { logger, lines } = capture();
    logger.info('hello');
    expect(lines[0]).toMatchObject({ service: 'distributed-wagering-processor', message: 'hello' });
    expect(typeof lines[0]?.time).toBe('string');
  });

  it('adds the ambient context to every line', async () => {
    const { logger, lines } = capture();
    await runWithLogContext({ correlationId: 'c-1', messageId: 'm-1' }, async () => {
      logger.info('first');
      await Bun.sleep(1);
      logger.child({ module: 'deep' }).warn('second');
    });
    logger.info('outside');

    expect(lines[0]).toMatchObject({ correlationId: 'c-1', messageId: 'm-1' });
    expect(lines[1]).toMatchObject({ correlationId: 'c-1', messageId: 'm-1', module: 'deep' });
    expect(lines[2]).not.toHaveProperty('correlationId');
  });

  it('lets the explicit fields of a line win over the context', async () => {
    const { logger, lines } = capture();
    await runWithLogContext({ transactionId: 'from-context' }, async () => {
      logger.info({ transactionId: 'explicit' }, 'line');
      await Promise.resolve();
    });
    expect(lines[0]?.transactionId).toBe('explicit');
  });

  it('puts the request scope on the final request line, even outside the scope', async () => {
    const { logger, lines } = capture();
    const response = new ServerResponse(new IncomingMessage(new Socket()));
    await runWithLogContext({ correlationId: 'c-req' }, async () => {
      bindLogContextToResponse(response);
      await Promise.resolve();
    });
    // pino-http logs from the response 'finish'/'close' event, possibly out of the scope.
    logger.info({ res: response }, 'request completed');
    expect(lines[0]).toMatchObject({ correlationId: 'c-req', message: 'request completed' });
  });

  it('writes each context key once per line', async () => {
    const { logger, raw } = capture();
    const response = new ServerResponse(new IncomingMessage(new Socket()));
    await runWithLogContext({ correlationId: 'c-once', walletId: 'w-1' }, async () => {
      bindLogContextToResponse(response);
      await Promise.resolve();
      logger.child({ module: 'http' }).info({ res: response }, 'request completed');
    });
    // A parsed object would hide duplicates: count on the raw JSON text.
    expect(raw[0]?.match(/"correlationId"/g)).toHaveLength(1);
    expect(raw[0]?.match(/"walletId"/g)).toHaveLength(1);
  });

  it('redacts credentials, payloads and money values', () => {
    const { logger, lines } = capture();
    logger.info(
      {
        req: { headers: { authorization: 'Bearer secret', cookie: 'sid=1' }, body: { a: 1 } },
        payload: { full: 'event' },
        data: { full: 'message' },
        money: { amount: '25.00', currency: 'BRL' },
        amount: '25.00',
        balance: '75.00',
        transaction: { money: { amount: '25.00' }, observedBalance: '75.00' },
        wallet: { balance: '75.00', initialBalance: '100.00' },
      },
      'sensitive',
    );
    const text = JSON.stringify(lines[0]);
    expect(text).not.toContain('secret');
    expect(text).not.toContain('sid=1');
    expect(text).not.toMatch(/25\.00|75\.00|100\.00/);
    expect(lines[0]).toMatchObject({
      payload: '[REDACTED]',
      data: '[REDACTED]',
      money: '[REDACTED]',
    });
  });
});
