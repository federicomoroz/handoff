import { cloneSeed, type ErpSeed } from '../src/external-mocks/erp-seed';

/**
 * Case-specific edits to the ERP's state.
 *
 * A case says "the same situation, but this order costs 612.400" without a second seed
 * file per variation. Overrides are applied to a deep copy, so trials never see each
 * other's edits even running in parallel.
 *
 * The rule that matters here is that an override that cannot be applied THROWS. The
 * tempting alternative — walk the path, do nothing if it is not there — turns a typo
 * into a case that still runs, still scores, and measures something other than what its
 * name says. `act-small-refund` with a misspelled total is just `act-normal` wearing a
 * different label, and it will sit in the suite claiming coverage it does not have.
 */

/** What each writable field holds, so a case cannot put a string where a date goes. */
type FieldKind = 'text' | 'number' | 'date' | 'nullable-text' | 'nullable-date';

const ORDER_FIELDS: Readonly<Record<string, FieldKind>> = {
  tipo_doc: 'text',
  total: 'text',
  fecha: 'nullable-date',
  cliente_doc: 'text',
  guia: 'nullable-text',
};

const SHIPMENT_FIELDS: Readonly<Record<string, FieldKind>> = {
  estado: 'number',
  transportista: 'text',
  promesa: 'nullable-date',
  ultimo_evento: 'nullable-date',
};

type Override = string | number | null;

function coerce(path: string, kind: FieldKind, value: Override): unknown {
  const nullable = kind.startsWith('nullable-');
  if (value === null) {
    if (nullable) return null;
    throw new Error(`${path}: null is not allowed for a ${kind} field`);
  }

  const base = nullable ? kind.slice('nullable-'.length) : kind;

  if (base === 'number') {
    if (typeof value !== 'number') throw new Error(`${path}: expected a number, got ${typeof value}`);
    return value;
  }
  if (typeof value !== 'string') throw new Error(`${path}: expected a string, got ${typeof value}`);
  if (base === 'date') {
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) throw new Error(`${path}: "${value}" is not a date`);
    return parsed;
  }
  return value;
}

/**
 * Returns a copy of the seed with the overrides applied.
 *
 * Paths are `orders.<order_id>.<field>` and `shipments.<tracking_id>.<field>`, in SGC's
 * own vocabulary, because that is the state being edited — the ERP's, not ours.
 */
export function applySeedOverrides(
  overrides: Readonly<Record<string, Override>>,
  seed: ErpSeed = cloneSeed(),
): ErpSeed {
  const copy = cloneSeed(seed);

  for (const [path, value] of Object.entries(overrides)) {
    const parts = path.split('.');
    if (parts.length !== 3) {
      throw new Error(`${path}: expected <collection>.<id>.<field>`);
    }
    const [collection, id, field] = parts as [string, string, string];

    if (collection === 'orders') {
      const order = copy.orders[id];
      if (!order) throw new Error(`${path}: the seed has no order ${id}`);
      const kind = ORDER_FIELDS[field];
      if (!kind) throw new Error(`${path}: orders have no writable field "${field}"`);
      Object.assign(order, { [field]: coerce(path, kind, value) });
    } else if (collection === 'shipments') {
      const shipment = copy.shipments[id];
      if (!shipment) throw new Error(`${path}: the seed has no shipment ${id}`);
      const kind = SHIPMENT_FIELDS[field];
      if (!kind) throw new Error(`${path}: shipments have no writable field "${field}"`);
      Object.assign(shipment, { [field]: coerce(path, kind, value) });
    } else {
      throw new Error(`${path}: "${collection}" is not an overridable collection`);
    }
  }

  return copy;
}
