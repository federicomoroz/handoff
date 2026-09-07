import { describe, expect, it } from 'vitest';
import {
  normalizeNullable,
  parseDocType,
  parseSgcAmount,
  parseSgcDate,
  resolveShipmentState,
} from '../src/adapters/secondary/sgc-wire';

describe('normalizeNullable — hostility 5', () => {
  it('collapses the five shapes of "no value" into null', () => {
    for (const raw of [null, undefined, '', '   ', '-', 'N/A', 'n/a', 'sin dato']) {
      expect(normalizeNullable(raw)).toBeNull();
    }
  });

  it('does not swallow a real value', () => {
    expect(normalizeNullable('  OCA  ')).toBe('OCA');
    expect(normalizeNullable(0)).toBe('0');
  });
});

describe('parseSgcAmount — hostility 9', () => {
  it('reads the Argentine format into integer cents', () => {
    expect(parseSgcAmount('1.537,50')).toBe(153750);
    expect(parseSgcAmount('482.900,00')).toBe(48290000);
    expect(parseSgcAmount('999,9')).toBe(99990);
    expect(parseSgcAmount('1537')).toBe(153700);
    expect(parseSgcAmount('$ 1.537,50')).toBe(153750);
    expect(parseSgcAmount('-1.537,50')).toBe(-153750);
  });

  it('returns null instead of guessing when the format is ambiguous or foreign', () => {
    // Anglo format: it should not exist in this ERP. Guessing it would invent money.
    expect(parseSgcAmount('1,537.50')).toBeNull();
    expect(parseSgcAmount('1.537,505')).toBeNull();
    expect(parseSgcAmount('abc')).toBeNull();
    // The sign used to be peeled off before validating, so this became -500.
    expect(parseSgcAmount('- 5')).toBeNull();
    expect(parseSgcAmount('$ -100')).toBeNull();
    expect(parseSgcAmount('N/A')).toBeNull();
    expect(parseSgcAmount(null)).toBeNull();
  });
});

describe('parseSgcDate — hostility 8', () => {
  it('reads dd/mm/yyyy as Argentine local time', () => {
    expect(parseSgcDate('30/08/2026')?.toISOString()).toBe('2026-08-30T03:00:00.000Z');
    expect(parseSgcDate('30/08/2026 14:02')?.toISOString()).toBe('2026-08-30T17:02:00.000Z');
  });

  it('reads ISO without an offset as local time, and respects an explicit offset', () => {
    expect(parseSgcDate('2026-08-30T14:02:00')?.toISOString()).toBe('2026-08-30T17:02:00.000Z');
    expect(parseSgcDate('2026-08-30T14:02:00Z')?.toISOString()).toBe('2026-08-30T14:02:00.000Z');
  });

  it('reads epoch seconds', () => {
    // Literal expectation: computing it as `new Date(n * 1000)` would just re-run the
    // implementation and pass no matter what the code did.
    expect(parseSgcDate('1787000000')?.toISOString()).toBe('2026-08-17T20:53:20.000Z');
  });

  it('accepts a fractional second instead of losing the date', () => {
    expect(parseSgcDate('2026-08-30T14:02:00.500')?.toISOString()).toBe('2026-08-30T17:02:00.000Z');
  });

  it('rejects dates that do not exist, and junk', () => {
    expect(parseSgcDate('31/02/2026')).toBeNull();
    expect(parseSgcDate('30/13/2026')).toBeNull();
    expect(parseSgcDate('ayer')).toBeNull();
    expect(parseSgcDate('')).toBeNull();
  });
});

describe('resolveShipmentState — hostility 6', () => {
  it('the SAME code means different things depending on the document type', () => {
    // This pair is the whole hostility: `estado` comes from the shipment endpoint,
    // `tipo_doc` from the order one, and without both the number says nothing.
    expect(resolveShipmentState(3, 'FC')).toBe('delivered');
    expect(resolveShipmentState(3, 'NC')).toBe('cancelled');
  });

  it('agrees on the codes that do not diverge', () => {
    expect(resolveShipmentState(1, 'FC')).toBe('in_transit');
    expect(resolveShipmentState(1, 'NC')).toBe('in_transit');
    expect(resolveShipmentState(5, 'FC')).toBe('lost');
  });

  it('cannot resolve without the document type, and says so', () => {
    expect(resolveShipmentState(3, null)).toBeNull();
    expect(resolveShipmentState(null, 'FC')).toBeNull();
    expect(resolveShipmentState(99, 'FC')).toBeNull();
  });
});

describe('parseDocType', () => {
  it('accepts FC and NC in any case, rejects the rest', () => {
    expect(parseDocType('FC')).toBe('FC');
    expect(parseDocType('nc')).toBe('NC');
    expect(parseDocType('XX')).toBeNull();
    expect(parseDocType(null)).toBeNull();
  });
});
