import { describe, expect, it } from 'vitest';
import { addCents, cents, compareCents, formatArs, MoneyError, subCents } from '../src/domain/money';

describe('cents', () => {
  it('accepts integers and zero', () => {
    expect(cents(0)).toBe(0);
    expect(cents(153750)).toBe(153750);
    expect(cents(-500)).toBe(-500);
  });

  it('rejects anything that is not an exact integer', () => {
    expect(() => cents(15.5)).toThrow(MoneyError);
    expect(() => cents(NaN)).toThrow(MoneyError);
    expect(() => cents(Infinity)).toThrow(MoneyError);
    expect(() => cents(Number.MAX_SAFE_INTEGER + 10)).toThrow(MoneyError);
  });
});

describe('arithmetic', () => {
  it('adds and subtracts without binary error', () => {
    // The classic: 0.1 + 0.2 !== 0.3 in floats. In cents it is trivial.
    expect(addCents(cents(10), cents(20))).toBe(30);
    expect(subCents(cents(153750), cents(50))).toBe(153700);
  });

  it('orders', () => {
    expect(compareCents(cents(1), cents(2))).toBe(-1);
    expect(compareCents(cents(2), cents(2))).toBe(0);
    expect(compareCents(cents(3), cents(2))).toBe(1);
  });
});

describe('formatArs', () => {
  it('groups thousands with dots and separates decimals with a comma', () => {
    expect(formatArs(cents(153750))).toBe('$ 1.537,50');
    expect(formatArs(cents(48290000))).toBe('$ 482.900,00');
    expect(formatArs(cents(5))).toBe('$ 0,05');
    expect(formatArs(cents(0))).toBe('$ 0,00');
    expect(formatArs(cents(-153750))).toBe('-$ 1.537,50');
  });
});
