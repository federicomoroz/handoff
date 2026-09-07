import type { CustomerHistoryFacts, OrderFacts, ShipmentFacts } from '../domain/facts';
import type { Tracer } from '../domain/trace';

/**
 * The ERP port.
 *
 * It returns domain types, already clean: `Cents`, `Date` in UTC, resolved states. None
 * of SGC's ten hostilities crosses this line — they die on the adapter side, which is
 * where they belong.
 *
 * When a value cannot be obtained the answer is an explicit `null`, and the caller
 * records the missing fact. Never an invented value, never a field that quietly
 * disappears: a fact that goes missing silently is indistinguishable from a fact that
 * says "no".
 */

/** Part of the port's contract, not an adapter detail — which is why it lives here. */
export const ERP_TIMEOUT_MS = 5_000;

/** Attempts per request before giving up: covers 429s, 401s and truncated bodies. */
export const ERP_MAX_ATTEMPTS = 4;

/** Backoff ceiling, so a long `Retry-After` cannot stall the whole run. */
export const ERP_MAX_BACKOFF_MS = 2_000;

export class ErpUnavailableError extends Error {
  constructor(
    readonly endpoint: string,
    message: string,
    readonly attempts: number,
  ) {
    super(`SGC ${endpoint}: ${message}`);
    this.name = 'ErpUnavailableError';
  }
}

export interface ErpPort {
  /** The order. Always the first read: without `docType` the shipment cannot be read. */
  fetchOrder(orderId: string, tracer: Tracer): Promise<OrderFacts | null>;

  /**
   * The shipment. It needs the order's `docType` because the state code SGC returns
   * means nothing without it: `3` is delivered on an invoice and cancelled on a credit
   * note.
   */
  fetchShipment(
    trackingId: string,
    docType: 'FC' | 'NC',
    tracer: Tracer,
  ): Promise<ShipmentFacts | null>;

  /**
   * The 90-day history, already aggregated. The adapter pages and sums; SGC only
   * returns loose movements, and lies about how many there are.
   */
  fetchHistory(
    customerDoc: string,
    evaluatedAt: Date,
    tracer: Tracer,
  ): Promise<CustomerHistoryFacts | null>;

  /** Internal notes on the order. Here empty and absent are the same thing, on purpose. */
  fetchNotes(orderId: string, tracer: Tracer): Promise<readonly string[]>;
}
