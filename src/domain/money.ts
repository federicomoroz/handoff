/**
 * Money lives as integer cents. Never floats: `0.1 + 0.2` is not `0.3`, and a badly
 * rounded refund is somebody's real money.
 *
 * `Cents` is a branded type, so a loose `number` cannot reach a money slot without
 * going through `cents()`. The "no floats for money" rule is held by the compiler
 * rather than by a comment.
 */
export type Cents = number & { readonly __cents: unique symbol };

/** Safety ceiling: the largest exactly representable integer in JS. */
const MAX_SAFE_CENTS = Number.MAX_SAFE_INTEGER;

export class MoneyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MoneyError';
  }
}

/** The only constructor of `Cents`. Rejects non-integers, NaN, Infinity and overflow. */
export function cents(value: number): Cents {
  if (!Number.isFinite(value)) {
    throw new MoneyError(`amount is not finite: ${value}`);
  }
  if (!Number.isInteger(value)) {
    throw new MoneyError(`cents must be integers, got ${value}`);
  }
  if (Math.abs(value) > MAX_SAFE_CENTS) {
    throw new MoneyError(`amount outside the exact integer range: ${value}`);
  }
  return value as Cents;
}

export const addCents = (a: Cents, b: Cents): Cents => cents(a + b);
export const subCents = (a: Cents, b: Cents): Cents => cents(a - b);

/** `-1 | 0 | 1`, so callers can order and compare without unwrapping the number. */
export const compareCents = (a: Cents, b: Cents): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Human-facing format, Argentine style: `1537550` becomes `"$ 15.375,50"`.
 * Reports and logs only — never for arithmetic.
 */
export function formatArs(value: Cents): string {
  const negative = value < 0;
  const abs = Math.abs(value);
  const whole = Math.floor(abs / 100);
  const frac = String(abs % 100).padStart(2, '0');
  const grouped = String(whole).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return `${negative ? '-' : ''}$ ${grouped},${frac}`;
}
