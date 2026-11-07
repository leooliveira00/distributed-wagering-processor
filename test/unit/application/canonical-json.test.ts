import { describe, expect, it } from 'bun:test';
import { canonicalJson, payloadHash } from '../../../src/application/shared/canonical-json';

describe('canonicalJson', () => {
  it('sorts keys recursively and drops whitespace', () => {
    expect(canonicalJson({ b: 1, a: { d: true, c: 'x' } })).toBe('{"a":{"c":"x","d":true},"b":1}');
  });

  it('omits undefined members but keeps null', () => {
    expect(canonicalJson({ a: undefined, b: null })).toBe('{"b":null}');
  });

  it('keeps array order', () => {
    expect(canonicalJson({ list: [3, 1, 2] })).toBe('{"list":[3,1,2]}');
  });

  it('escapes strings like JSON', () => {
    expect(canonicalJson({ text: 'quote " and \\ backslash' })).toBe(
      '{"text":"quote \\" and \\\\ backslash"}',
    );
  });

  it.each([
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['a Date', new Date()],
    ['a function', () => undefined],
    ['a class instance', new Map([['a', 1]])],
  ])('rejects %s instead of coercing it', (_, value) => {
    expect(() => canonicalJson({ value })).toThrow(TypeError);
  });
});

describe('payloadHash', () => {
  const payload = {
    providerId: 'provider-a',
    kind: 'BET',
    money: { amount: '25.00', currency: 'BRL' },
  };

  it('is a lowercase SHA-256 hex digest', () => {
    expect(payloadHash(payload)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('does not depend on key order', () => {
    const reordered = {
      money: { currency: 'BRL', amount: '25.00' },
      kind: 'BET',
      providerId: 'provider-a',
    };

    expect(payloadHash(reordered)).toBe(payloadHash(payload));
  });

  it('changes when any business field changes', () => {
    expect(payloadHash({ ...payload, money: { amount: '25.01', currency: 'BRL' } })).not.toBe(
      payloadHash(payload),
    );
  });

  it('is stable across runs (known vector)', () => {
    // sha256('{"a":1}')
    expect(payloadHash({ a: 1 })).toBe(
      '015abd7f5cc57a2dd94b7590f04ad8084273905ee33ec5cebeae62276a97f862',
    );
  });
});
