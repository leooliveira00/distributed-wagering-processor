import { describe, expect, it } from 'bun:test';
import { InboxMessage } from '../../../../src/domain/messaging/inbox-message';
import {
  InvalidMessageError,
  InvalidMessageStateError,
} from '../../../../src/domain/messaging/messaging.errors';
import { AT, HASH, LATER } from '../fixtures';

const receive = (overrides: Partial<Parameters<typeof InboxMessage.receive>[0]> = {}) =>
  InboxMessage.receive({
    messageId: 'msg-123',
    consumerName: 'wager-transactions-consumer',
    payloadHash: HASH,
    receivedAt: AT,
    ...overrides,
  });

describe('InboxMessage', () => {
  it('is received unprocessed', () => {
    const message = receive();

    expect(message.isProcessed()).toBe(false);
    expect(message.processedAt).toBeUndefined();
  });

  it('records when it was processed', () => {
    const message = receive();
    message.markProcessed(LATER);

    expect(message.isProcessed()).toBe(true);
    expect(message.processedAt).toEqual(LATER);
  });

  it('cannot be processed twice', () => {
    const message = receive();
    message.markProcessed(LATER);

    expect(() => {
      message.markProcessed(LATER);
    }).toThrow(InvalidMessageStateError);
  });

  it('distinguishes a true duplicate from the same id with a different payload', () => {
    const message = receive({ payloadHash: 'a'.repeat(64) });

    expect(message.matchesPayload('a'.repeat(64))).toBe(true);
    expect(message.matchesPayload('b'.repeat(64))).toBe(false);
  });

  it.each([
    ['blank message id', { messageId: ' ' }],
    ['blank consumer name', { consumerName: '' }],
    ['malformed payload hash', { payloadHash: 'xyz' }],
  ])('rejects a %s', (_, overrides) => {
    expect(() => receive(overrides)).toThrow(InvalidMessageError);
  });

  it('rehydrates a processed message', () => {
    const message = InboxMessage.rehydrate({
      messageId: 'msg-1',
      consumerName: 'consumer',
      payloadHash: HASH,
      receivedAt: AT,
      processedAt: LATER,
    });

    expect(message.isProcessed()).toBe(true);
  });
});
