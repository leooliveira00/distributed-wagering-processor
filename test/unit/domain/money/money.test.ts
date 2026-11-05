import { describe, expect, it } from 'bun:test';
import { Money } from '../../../../src/domain/money/money';
import {
  CurrencyMismatchError,
  InvalidMoneyError,
} from '../../../../src/domain/money/money.errors';

const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });
const usd = (amount: string) => Money.from({ amount, currency: 'USD' });

describe('Money.from', () => {
  it.each(['0.00', '0.01', '25.50', '1000.00', '999999999999999999.99'])('accepts %p', (amount) => {
    expect(brl(amount).toJSON()).toEqual({ amount, currency: 'BRL' });
  });

  it.each([
    ['without decimals', '25'],
    ['with one decimal', '25.5'],
    ['with more than two decimals', '25.505'],
    ['negative', '-1.00'],
    ['with explicit plus sign', '+25.00'],
    ['in scientific notation', '1e3'],
    ['in scientific notation with decimals', '1.50e2'],
    ['NaN', 'NaN'],
    ['Infinity', 'Infinity'],
    ['negative Infinity', '-Infinity'],
    ['empty', ''],
    ['blank', '   '],
    ['with leading whitespace', ' 25.00'],
    ['with trailing whitespace', '25.00 '],
    ['with leading zero', '025.00'],
    ['with double zero', '00.00'],
    ['with thousands separator', '1,000.00'],
    ['with comma as decimal separator', '25,00'],
    ['missing integer part', '.50'],
    ['missing decimal part', '25.'],
    ['hexadecimal', '0x1A'],
    ['above numeric(20,2) range', '1000000000000000000.00'],
  ])('rejects an amount %s (%p)', (_, amount) => {
    expect(() => brl(amount)).toThrow(InvalidMoneyError);
  });

  it('rejects a non-string amount at runtime', () => {
    expect(() => Money.from({ amount: 25 as unknown as string, currency: 'BRL' })).toThrow(
      InvalidMoneyError,
    );
  });

  it.each(['brl', 'BR', 'BRLL', '', 'R$', ' BRL'])('rejects currency %p', (currency) => {
    expect(() => Money.from({ amount: '1.00', currency })).toThrow(InvalidMoneyError);
  });
});

describe('Money.zero', () => {
  it('creates a zero amount in the given currency', () => {
    const zero = Money.zero('BRL');

    expect(zero.isZero()).toBe(true);
    expect(zero.toJSON()).toEqual({ amount: '0.00', currency: 'BRL' });
  });

  it('validates the currency', () => {
    expect(() => Money.zero('brl')).toThrow(InvalidMoneyError);
  });
});

describe('Money arithmetic', () => {
  it('adds exactly where binary floating point would not (0.10 + 0.20)', () => {
    expect(0.1 + 0.2).not.toBe(0.3);
    expect(brl('0.10').add(brl('0.20')).equals(brl('0.30'))).toBe(true);
  });

  it('subtracts exactly', () => {
    expect(brl('100.00').subtract(brl('80.00')).toJSON().amount).toBe('20.00');
  });

  it('never rounds: one hundred additions of 0.01 equal exactly 1.00', () => {
    let total = Money.zero('BRL');
    for (let i = 0; i < 100; i++) total = total.add(brl('0.01'));

    expect(total.toJSON().amount).toBe('1.00');
  });

  it('keeps exactness at the upper bound of the contract', () => {
    const result = brl('999999999999999999.99').add(brl('0.01'));

    expect(result.toJSON().amount).toBe('1000000000000000000.00');
  });

  it('allows negative results internally and serializes them with sign', () => {
    const difference = brl('10.00').subtract(brl('15.00'));

    expect(difference.isNegative()).toBe(true);
    expect(difference.toJSON().amount).toBe('-5.00');
  });

  it('negates values', () => {
    expect(brl('25.00').negate().toJSON().amount).toBe('-25.00');
    expect(brl('25.00').negate().negate().equals(brl('25.00'))).toBe(true);
  });

  it('never produces negative zero', () => {
    expect(Money.zero('BRL').negate().toJSON().amount).toBe('0.00');
    expect(brl('5.00').subtract(brl('5.00')).negate().toJSON().amount).toBe('0.00');
  });

  it('always serializes with a fixed scale of 2', () => {
    expect(brl('10.50').add(brl('0.50')).toJSON().amount).toBe('11.00');
  });
});

describe('Money comparisons', () => {
  it('classifies sign', () => {
    expect(brl('0.00').isZero()).toBe(true);
    expect(brl('0.01').isPositive()).toBe(true);
    expect(brl('0.00').isPositive()).toBe(false);
    expect(brl('0.00').isNegative()).toBe(false);
  });

  it('compares values in the same currency', () => {
    expect(brl('79.99').isLessThan(brl('80.00'))).toBe(true);
    expect(brl('80.00').isLessThan(brl('80.00'))).toBe(false);
    expect(brl('80.01').isLessThan(brl('80.00'))).toBe(false);
  });

  it('treats equal values as equal regardless of instance', () => {
    expect(brl('25.00').equals(brl('25.00'))).toBe(true);
    expect(brl('25.00').equals(brl('25.01'))).toBe(false);
  });
});

describe('Money currency conflicts', () => {
  it.each([
    ['add', (a: Money, b: Money) => a.add(b)],
    ['subtract', (a: Money, b: Money) => a.subtract(b)],
    ['isLessThan', (a: Money, b: Money) => a.isLessThan(b)],
  ])('%s throws CurrencyMismatchError across currencies', (_, operation) => {
    expect(() => operation(brl('1.00'), usd('1.00'))).toThrow(CurrencyMismatchError);
  });

  it('reports expected and received currencies', () => {
    try {
      brl('1.00').add(usd('1.00'));
      throw new Error('expected add to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(CurrencyMismatchError);
      const mismatch = error as CurrencyMismatchError;
      expect(mismatch.code).toBe('CURRENCY_MISMATCH');
      expect([mismatch.expected, mismatch.received]).toEqual(['BRL', 'USD']);
    }
  });

  it('equals returns false across currencies instead of throwing', () => {
    expect(brl('1.00').equals(usd('1.00'))).toBe(false);
  });
});

describe('Money immutability and serialization', () => {
  it('returns new instances and leaves operands untouched', () => {
    const original = brl('10.00');
    const result = original.add(brl('5.00'));

    expect(result).not.toBe(original);
    expect(original.toJSON().amount).toBe('10.00');
  });

  it('is frozen at runtime', () => {
    const money = brl('10.00');

    expect(Object.isFrozen(money)).toBe(true);
    expect(() => {
      (money as unknown as { currency: string }).currency = 'USD';
    }).toThrow(TypeError);
  });

  it('serializes to stable JSON with MoneyProps shape', () => {
    expect(JSON.stringify({ money: brl('25.00') })).toBe(
      '{"money":{"amount":"25.00","currency":"BRL"}}',
    );
  });

  it('has a readable string form', () => {
    expect(brl('25.00').toString()).toBe('25.00 BRL');
  });
});
