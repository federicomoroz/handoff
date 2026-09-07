import type { Cents } from './money';
import type { Incident } from './incident';

/** Shipment state. `delivered`, `returned`, `lost` and `cancelled` are terminal. */
export type ShipmentState = 'in_transit' | 'delivered' | 'returned' | 'lost' | 'cancelled';

export const TERMINAL_SHIPMENT_STATES: readonly ShipmentState[] = [
  'delivered',
  'returned',
  'lost',
  'cancelled',
];

export interface OrderFacts {
  readonly orderId: string;
  /** `FC` invoice, `NC` credit note. It changes what the shipment state code means. */
  readonly docType: 'FC' | 'NC';
  readonly total: Cents;
  /** `null` when the ERP sent a date we could not read. Said out loud, never invented. */
  readonly placedAt: Date | null;
  readonly customerDoc: string;
  /**
   * The shipment tracking id. It comes from the order, which is the other reason the
   * read sequence is forced: without the order there is no shipment to ask for.
   */
  readonly trackingId: string | null;
}

export interface ShipmentFacts {
  readonly trackingId: string;
  readonly state: ShipmentState;
  readonly carrier: string;
  readonly promisedAt: Date | null;
  readonly lastEventAt: Date | null;
}

export interface CustomerHistoryFacts {
  readonly customerDoc: string;
  readonly claimsLast90Days: number;
  readonly refundedLast90Days: Cents;
  readonly ordersLast90Days: number;
}

/**
 * Everything the agent managed to learn about one incident.
 *
 * Nulls are explicit and always come with an entry in `missingFacts`: a fact that goes
 * missing silently is indistinguishable from a fact that says "no", and that confusion
 * ruins both a decision and an eval.
 */
export interface CaseFacts {
  readonly incident: Incident;
  /** The case clock. Injected, never `new Date()`, so an old case does not rot. */
  readonly evaluatedAt: Date;
  readonly order: OrderFacts | null;
  readonly shipment: ShipmentFacts | null;
  readonly history: CustomerHistoryFacts | null;
  readonly notes: readonly string[];
  readonly missingFacts: readonly string[];
}

type FactExtractor = (facts: CaseFacts) => string | null;

/**
 * The citable-fact vocabulary, written exactly once.
 *
 * Three things must always agree, and all three read from here: the fact list the model
 * sees in its prompt, the set `evidenceGrounded` validates citations against, and the
 * paths used by the eval labels. Written three times it drifts by the third edit;
 * written once, the code asks and this map answers.
 */
export const FACT_PATHS: Readonly<Record<string, FactExtractor>> = {
  'order.doc_type': (f) => f.order?.docType ?? null,
  'order.total': (f) => (f.order ? String(f.order.total) : null),
  'order.date': (f) => f.order?.placedAt?.toISOString() ?? null,
  'order.customer': (f) => f.order?.customerDoc ?? null,
  'order.tracking': (f) => f.order?.trackingId ?? null,
  'shipment.state': (f) => f.shipment?.state ?? null,
  'shipment.carrier': (f) => f.shipment?.carrier ?? null,
  'shipment.promised_at': (f) => f.shipment?.promisedAt?.toISOString() ?? null,
  'shipment.last_event_at': (f) => f.shipment?.lastEventAt?.toISOString() ?? null,
  'history.claims_90d': (f) => (f.history ? String(f.history.claimsLast90Days) : null),
  'history.refunded_90d': (f) => (f.history ? String(f.history.refundedLast90Days) : null),
  'history.orders_90d': (f) => (f.history ? String(f.history.ordersLast90Days) : null),
  notes: (f) => (f.notes.length > 0 ? f.notes.join(' | ') : null),
};

/** The vocabulary paths this case actually has. Empty is not the same as absent. */
export function presentFactPaths(facts: CaseFacts): ReadonlySet<string> {
  const present = new Set<string>();
  for (const [path, extract] of Object.entries(FACT_PATHS)) {
    if (extract(facts) !== null) present.add(path);
  }
  return present;
}
