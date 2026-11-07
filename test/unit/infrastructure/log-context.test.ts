import { describe, expect, it } from 'bun:test';
import {
  addToLogContext,
  currentLogContext,
  runWithLogContext,
} from '../../../src/infrastructure/observability/log-context';

describe('log context', () => {
  it('is empty outside a scope, where adding is a no-op', () => {
    addToLogContext({ walletId: 'w-1' });
    expect(currentLogContext()).toEqual({});
  });

  it('carries the scope fields across awaits', async () => {
    await runWithLogContext({ correlationId: 'c-1' }, async () => {
      await Bun.sleep(1);
      expect(currentLogContext()).toEqual({ correlationId: 'c-1' });
    });
  });

  it('adds fields to the current scope only', async () => {
    await runWithLogContext({ correlationId: 'c-1' }, async () => {
      addToLogContext({ transactionId: 't-1', walletId: undefined });
      await Bun.sleep(1);
      expect(currentLogContext()).toEqual({ correlationId: 'c-1', transactionId: 't-1' });
    });
    expect(currentLogContext()).toEqual({});
  });

  it('nests scopes: inner fields win and the outer scope is restored', async () => {
    await runWithLogContext({ correlationId: 'outer', walletId: 'w-1' }, async () => {
      await runWithLogContext({ correlationId: 'inner', messageId: 'm-1' }, async () => {
        await Bun.sleep(1);
        addToLogContext({ transactionId: 't-1' });
        expect(currentLogContext()).toEqual({
          correlationId: 'inner',
          walletId: 'w-1',
          messageId: 'm-1',
          transactionId: 't-1',
        });
      });
      expect(currentLogContext()).toEqual({ correlationId: 'outer', walletId: 'w-1' });
    });
  });

  it('never mixes concurrent scopes', async () => {
    const seen = await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        runWithLogContext({ correlationId: `c-${String(index)}` }, async () => {
          await Bun.sleep(Math.random() * 5);
          addToLogContext({ transactionId: `t-${String(index)}` });
          await Bun.sleep(Math.random() * 5);
          return currentLogContext();
        }),
      ),
    );
    seen.forEach((context, index) => {
      expect(context).toEqual({
        correlationId: `c-${String(index)}`,
        transactionId: `t-${String(index)}`,
      });
    });
  });

  it('returns a copy: callers cannot change the scope through it', async () => {
    await runWithLogContext({ correlationId: 'c-1' }, async () => {
      const copy = currentLogContext();
      copy.correlationId = 'tampered';
      await Bun.sleep(0);
      expect(currentLogContext().correlationId).toBe('c-1');
    });
  });
});
