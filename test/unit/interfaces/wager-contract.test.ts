import { describe, expect, it } from 'bun:test';
import {
  isSafeCorrelationId,
  wagerMessageSchema,
} from '../../../src/interfaces/contracts/wager-contract';

/** README §10 example message. */
const message = () => ({
  messageId: 'msg-123',
  type: 'WagerTransactionRequested',
  occurredAt: '2026-07-29T15:00:00.000Z',
  data: {
    providerId: 'provider-a',
    externalTransactionId: 'transaction-123',
    idempotencyKey: 'provider-a:transaction-123',
    playerId: '0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1',
    walletId: '0192f291-27dd-7d3f-8071-5f8685deef37',
    roundId: 'round-987',
    gameId: 'fortune-chimp',
    kind: 'BET',
    money: { amount: '25.00', currency: 'BRL' },
  },
});

describe('wagerMessageSchema', () => {
  it('accepts the README §10 example', () => {
    expect(wagerMessageSchema.safeParse(message()).success).toBe(true);
  });

  it('puts UUIDs in canonical lowercase form, so the hash never depends on letter case', () => {
    const upper = message();
    upper.data.playerId = upper.data.playerId.toUpperCase();
    upper.data.walletId = upper.data.walletId.toUpperCase();

    const parsed = wagerMessageSchema.parse(upper);

    expect(parsed.data.playerId).toBe('0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1');
    expect(parsed.data.walletId).toBe('0192f291-27dd-7d3f-8071-5f8685deef37');
  });

  it.each([
    ['another message type', { ...message(), type: 'SomethingElse' }],
    ['a non ISO occurredAt', { ...message(), occurredAt: 'yesterday' }],
    ['an empty messageId', { ...message(), messageId: '' }],
    ['an unknown envelope field', { ...message(), extra: true }],
    [
      'a missing idempotency key',
      { ...message(), data: { ...message().data, idempotencyKey: undefined } },
    ],
    [
      'an idempotency key with spaces',
      { ...message(), data: { ...message().data, idempotencyKey: 'a b' } },
    ],
    ['an unknown data field', { ...message(), data: { ...message().data, extra: 1 } }],
    [
      'a numeric amount',
      { ...message(), data: { ...message().data, money: { amount: 25, currency: 'BRL' } } },
    ],
  ])('rejects %s', (_, candidate) => {
    expect(wagerMessageSchema.safeParse(candidate).success).toBe(false);
  });
});

describe('isSafeCorrelationId', () => {
  it.each(['msg-123', 'corr.1:abc_DEF', 'a'.repeat(128)])('accepts %p', (value) => {
    expect(isSafeCorrelationId(value)).toBe(true);
  });

  it.each([
    ['a line break (log injection)', 'ok\n{"level":50,"msg":"forged"}'],
    ['spaces', 'has spaces'],
    ['quotes', 'a"b'],
    ['too long', 'a'.repeat(129)],
    ['empty', ''],
    ['a non-string', 42],
  ])('rejects %s', (_, value) => {
    expect(isSafeCorrelationId(value)).toBe(false);
  });
});
