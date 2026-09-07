import { cents, type Cents } from '../../domain/money';
import type { ShipmentState } from '../../domain/facts';
import { ART_OFFSET_HOURS } from '../../domain/time';

/**
 * SGC's wire parsers. This is where the ERP's hostility dies: everything that has ONE
 * correct answer is resolved in code and never reaches the model.
 *
 * They are pure functions with no network and no state, so they are tested on their
 * own. Each returns `null` instead of throwing when a value cannot be interpreted; the
 * caller turns that `null` into a `missingFacts` entry, so the absence is said out loud
 * instead of disappearing.
 */

/** The four ways SGC says "no value". None of them is a plain `undefined`. */
const NULL_TOKENS = new Set(['', '-', 'n/a', 'N/A', 'null', 'NULL', 'sin dato']);

/**
 * Hostility 5: the same absent field arrives as `null`, `""`, `"N/A"`, `"-"` or with the
 * key missing entirely, depending on the endpoint and sometimes on the row. Normalised
 * in one place so no scattered `if (x)` gets to decide on its own.
 */
export function normalizeNullable(raw: unknown): string | null {
  if (raw === null || raw === undefined) return null;
  const text = String(raw).trim();
  if (text === '' || NULL_TOKENS.has(text) || NULL_TOKENS.has(text.toLowerCase())) return null;
  return text;
}

/**
 * Hostility 9: amounts arrive as `"1.537,50"` — dot for thousands, comma for decimals.
 * Returns integer cents. Ambiguity is rejected rather than guessed: `"1,537.50"` is the
 * anglo format and should not exist in this ERP, so it is `null` and a missing fact
 * rather than an optimistic interpretation.
 */
export function parseSgcAmount(raw: unknown): Cents | null {
  const text = normalizeNullable(raw);
  if (text === null) return null;

  // One regex for the whole string, so the sign cannot be peeled off a value that is
  // otherwise malformed. Reading `- 5` as -500 was exactly that: the minus was stripped,
  // the rest was trimmed, and a shape the ERP never emits became a number.
  const match = /^(-)?(?:\$ ?)?(\d{1,3}(?:\.\d{3})*|\d+)(?:,(\d{1,2}))?$/.exec(text);
  if (!match) return null;

  const [, sign, whole = '0', frac = ''] = match;
  const total = Number(whole.replace(/\./g, '')) * 100 + Number(frac.padEnd(2, '0') || '0');
  if (!Number.isSafeInteger(total)) return null;

  return cents(sign ? -total : total);
}

/**
 * Hostility 8: three date formats coexisting, and none of them carries a timezone.
 * `dd/mm/yyyy [hh:mm[:ss]]` and ISO without an offset are read as Argentine local time;
 * ISO with `Z` or an explicit offset is respected; large integers are epoch seconds.
 */
export function parseSgcDate(raw: unknown): Date | null {
  const text = normalizeNullable(raw);
  if (text === null) return null;

  if (/^\d+$/.test(text)) {
    const epoch = Number(text);
    if (epoch < 1_000_000_000 || epoch > 4_000_000_000) return null;
    return new Date(epoch * 1000);
  }

  const dmy = /^(\d{2})\/(\d{2})\/(\d{4})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?$/.exec(text);
  if (dmy) {
    const [, day, month, year, hour = '0', minute = '0', second = '0'] = dmy;
    return fromLocal(Number(year), Number(month), Number(day), Number(hour), Number(minute), Number(second));
  }

  // The fractional part is accepted and discarded: an ERP that starts emitting
  // milliseconds should not silently lose every date it sends.
  const iso = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?)?$/.exec(text);
  if (iso) {
    const [, year, month, day, hour = '0', minute = '0', second = '0'] = iso;
    return fromLocal(Number(year), Number(month), Number(day), Number(hour), Number(minute), Number(second));
  }

  if (/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2})?(\.\d+)?(Z|[+-]\d{2}:?\d{2})$/.test(text)) {
    const parsed = new Date(text.replace(' ', 'T'));
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }

  return null;
}

function fromLocal(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
): Date | null {
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59 || second > 59) {
    return null;
  }

  // Rejects days that do not exist: `31/02/2026` would survive `Date.UTC` by rolling
  // into March.
  const civil = new Date(Date.UTC(year, month - 1, day));
  if (
    civil.getUTCFullYear() !== year ||
    civil.getUTCMonth() !== month - 1 ||
    civil.getUTCDate() !== day
  ) {
    return null;
  }

  return new Date(Date.UTC(year, month - 1, day, hour - ART_OFFSET_HOURS, minute, second));
}

/**
 * Hostility 6, the worst of the ten: `estado` is a number whose meaning depends on
 * `tipo_doc`, which comes from ANOTHER endpoint. `3` is delivered on an invoice and
 * cancelled on a credit note. Without the order, the shipment cannot be read.
 *
 * Resolved with a table, never by explaining it to the model: it is a translation with
 * exactly one correct answer, and handing it to the model makes it probabilistic.
 */
const STATE_BY_DOC_TYPE: Readonly<Record<'FC' | 'NC', Readonly<Record<number, ShipmentState>>>> = {
  FC: { 1: 'in_transit', 2: 'in_transit', 3: 'delivered', 4: 'returned', 5: 'lost' },
  NC: { 1: 'in_transit', 2: 'in_transit', 3: 'cancelled', 4: 'returned', 5: 'lost' },
};

export function resolveShipmentState(
  state: unknown,
  docType: 'FC' | 'NC' | null,
): ShipmentState | null {
  const text = normalizeNullable(state);
  if (text === null || docType === null || !/^\d+$/.test(text)) return null;
  return STATE_BY_DOC_TYPE[docType][Number(text)] ?? null;
}

/** `FC` / `NC`, or `null` if SGC sent anything else. */
export function parseDocType(raw: unknown): 'FC' | 'NC' | null {
  const text = normalizeNullable(raw)?.toUpperCase();
  return text === 'FC' || text === 'NC' ? text : null;
}
