import { describe, expect, it } from 'bun:test';
import { WalletBalanceChanged } from '../../../../src/domain/messaging/events/wallet-balance-changed';
import { InvalidMessageStateError } from '../../../../src/domain/messaging/messaging.errors';
import { OutboxMessage } from '../../../../src/domain/messaging/outbox-message';
import { AT, LATER, brl, nextId, openWallet } from '../fixtures';

function balanceChangedEvent() {
  const wallet = openWallet('100.00');
  const entry = wallet.debit(brl('25.00'), { transactionId: 'tx-1', entryId: 'entry-1', at: AT });
  return WalletBalanceChanged.from(wallet, entry, {
    eventId: nextId('event'),
    correlationId: 'corr-1',
    occurredAt: AT,
  });
}

const seconds = (date: Date | undefined) => (date ? (date.getTime() - AT.getTime()) / 1000 : NaN);

describe('OutboxMessage.enqueue', () => {
  it('stores the serialized envelope, keyed by the event id', () => {
    const event = balanceChangedEvent();
    const message = OutboxMessage.enqueue(event);

    expect(message.id).toBe(event.eventId);
    expect(message.aggregateId).toBe(event.aggregateId);
    expect(message.eventType).toBe('WalletBalanceChanged');
    expect(message.payload).toEqual({ ...event.toJSON() });
    expect(message.occurredAt).toEqual(AT);
  });

  it('starts pending, due immediately and without attempts', () => {
    const message = OutboxMessage.enqueue(balanceChangedEvent());

    expect(message.isPending()).toBe(true);
    expect(message.isDue(AT)).toBe(true);
    expect(message.attempts).toBe(0);
  });

  it('has an immutable payload', () => {
    const message = OutboxMessage.enqueue(balanceChangedEvent());

    expect(Object.isFrozen(message.payload)).toBe(true);
    expect(Object.isFrozen(message.payload.data)).toBe(true);
  });
});

describe('OutboxMessage retries', () => {
  it('backs off exponentially and is not due before the next attempt', () => {
    const message = OutboxMessage.enqueue(balanceChangedEvent());

    message.scheduleRetry(AT);
    expect(message.attempts).toBe(1);
    expect(seconds(message.nextAttemptAt)).toBe(1);
    expect(message.isDue(AT)).toBe(false);
    expect(message.isDue(new Date(AT.getTime() + 1_000))).toBe(true);

    message.scheduleRetry(AT);
    message.scheduleRetry(AT);
    expect(message.attempts).toBe(3);
    expect(seconds(message.nextAttemptAt)).toBe(4);
  });

  it('accepts a custom backoff policy', () => {
    const message = OutboxMessage.enqueue(balanceChangedEvent());
    message.scheduleRetry(AT, { baseMs: 100, capMs: 100 });

    expect(seconds(message.nextAttemptAt)).toBe(0.1);
  });
});

describe('OutboxMessage publication', () => {
  it('stops being pending once published', () => {
    const message = OutboxMessage.enqueue(balanceChangedEvent());
    message.markPublished(LATER);

    expect(message.isPending()).toBe(false);
    expect(message.isDue(LATER)).toBe(false);
    expect(message.publishedAt).toEqual(LATER);
  });

  it.each([
    [
      'markPublished',
      (message: OutboxMessage) => {
        message.markPublished(LATER);
      },
    ],
    [
      'scheduleRetry',
      (message: OutboxMessage) => {
        message.scheduleRetry(LATER);
      },
    ],
  ])('%s is not allowed after publication', (_, operation) => {
    const message = OutboxMessage.enqueue(balanceChangedEvent());
    message.markPublished(LATER);

    expect(() => {
      operation(message);
    }).toThrow(InvalidMessageStateError);
  });
});

describe('OutboxMessage.rehydrate', () => {
  it('restores retry and publication state', () => {
    const message = OutboxMessage.rehydrate({
      id: 'event-1',
      aggregateId: 'wallet-1',
      eventType: 'WalletBalanceChanged',
      payload: { eventId: 'event-1' },
      occurredAt: AT,
      attempts: 4,
      nextAttemptAt: LATER,
      publishedAt: undefined,
    });

    expect(message.attempts).toBe(4);
    expect(message.isDue(AT)).toBe(false);
    expect(message.isDue(LATER)).toBe(true);
  });
});
