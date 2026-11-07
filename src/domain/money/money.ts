import Decimal from 'decimal.js';
import { CurrencyMismatchError, InvalidMoneyError } from './money.errors';

/** Wire format of a monetary amount. Interfaces are appropriate for DTOs. */
export interface MoneyProps {
  amount: string; // decimal string with exactly 2 decimal places, e.g. "25.00"
  currency: string; // ISO-4217 alphabetic code, e.g. "BRL"
}

const SCALE = 2;

/**
 * Input contract: non-negative, no leading zeros, exactly 2 decimal places and at most 18 integer
 * digits (fits `numeric(20,2)`). Rejects NaN, Infinity, scientific notation, signs and whitespace
 * by construction, since none of them match.
 */
const AMOUNT_PATTERN = /^(0|[1-9]\d{0,17})\.\d{2}$/;
/** Largest value the pattern above admits, and the capacity of a `numeric(20,2)` column. */
const MAX_AMOUNT = '999999999999999999.99';

/** Format check only (three uppercase letters); the code list itself is not validated. */
const CURRENCY_PATTERN = /^[A-Z]{3}$/;

/**
 * Isolated Decimal configuration, so global settings can never change money arithmetic.
 * Precision is far above what sums of `numeric(20,2)` values need, and the exponent limits
 * keep `toFixed` free of scientific notation.
 */
const MoneyDecimal = Decimal.clone({
  precision: 40,
  rounding: Decimal.ROUND_HALF_EVEN,
  toExpNeg: -40,
  toExpPos: 40,
});

/**
 * Immutable monetary value. Every operation returns a new instance.
 *
 * `from` enforces the external contract (non-negative). Arithmetic inside the domain may
 * produce negative values, e.g. a reconciliation difference, which is why `negate` and
 * `isNegative` exist. Inputs never carry more than 2 decimals, so addition and subtraction
 * are always exact and no rounding ever takes place.
 */
export class Money {
  private constructor(
    private readonly value: Decimal,
    public readonly currency: string,
  ) {
    if (value.decimalPlaces() > SCALE) {
      throw new InvalidMoneyError(`Money cannot have more than ${SCALE} decimal places`);
    }
    Object.freeze(this);
  }

  static from(props: MoneyProps): Money {
    const { amount, currency } = props as { amount: unknown; currency: unknown };
    if (typeof amount !== 'string' || !AMOUNT_PATTERN.test(amount)) {
      throw new InvalidMoneyError(
        `Invalid amount: expected a non-negative decimal string with exactly ${SCALE} decimal places`,
      );
    }
    return new Money(new MoneyDecimal(amount), Money.assertCurrency(currency));
  }

  static zero(currency: string): Money {
    return new Money(new MoneyDecimal(0), Money.assertCurrency(currency));
  }

  /**
   * The largest amount a balance can hold: 18 integer digits and 2 decimals, the input contract
   * above and the `numeric(20,2)` columns. A balance past it cannot be stored, so crediting it
   * must be refused as a business rule, not discovered as a database error.
   */
  static max(currency: string): Money {
    return new Money(new MoneyDecimal(MAX_AMOUNT), Money.assertCurrency(currency));
  }

  add(other: Money): Money {
    this.assertSameCurrency(other);
    return Money.of(this.value.plus(other.value), this.currency);
  }

  subtract(other: Money): Money {
    this.assertSameCurrency(other);
    return Money.of(this.value.minus(other.value), this.currency);
  }

  negate(): Money {
    return Money.of(this.value.negated(), this.currency);
  }

  isZero(): boolean {
    return this.value.isZero();
  }

  isPositive(): boolean {
    return this.value.greaterThan(0);
  }

  isNegative(): boolean {
    return this.value.lessThan(0);
  }

  isLessThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.value.lessThan(other.value);
  }

  isGreaterThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.value.greaterThan(other.value);
  }

  /** Values in different currencies are never equal; this does not throw. */
  equals(other: Money): boolean {
    return this.currency === other.currency && this.value.equals(other.value);
  }

  toJSON(): MoneyProps {
    return { amount: this.value.toFixed(SCALE), currency: this.currency };
  }

  toString(): string {
    return `${this.value.toFixed(SCALE)} ${this.currency}`;
  }

  private assertSameCurrency(other: Money): void {
    if (other.currency !== this.currency) {
      throw new CurrencyMismatchError(this.currency, other.currency);
    }
  }

  /** Normalizes negative zero so it never serializes as "-0.00". */
  private static of(value: Decimal, currency: string): Money {
    return new Money(value.isZero() ? new MoneyDecimal(0) : value, currency);
  }

  private static assertCurrency(currency: unknown): string {
    if (typeof currency !== 'string' || !CURRENCY_PATTERN.test(currency)) {
      throw new InvalidMoneyError('Invalid currency: expected an ISO-4217 code such as "BRL"');
    }
    return currency;
  }
}
