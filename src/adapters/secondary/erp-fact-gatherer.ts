import type { CaseFacts, OrderFacts, ShipmentFacts } from '../../domain/facts';
import type { Incident } from '../../domain/incident';
import type { Tracer } from '../../domain/trace';
import { ErpUnavailableError, type ErpPort } from '../../ports/erp';
import type { FactGathererPort } from '../../ports/triage';

/**
 * Gathers the facts by reading SGC in the only order that works.
 *
 * The sequence is not a design choice, it is a consequence of the ERP: without the
 * order's `docType` the shipment state means nothing, and without the customer document
 * there is no history to ask for. It has ONE correct answer, so the code does it.
 * Letting the model discover it would measure tool routing instead of judgement, and
 * pay for it with five model calls per case instead of one.
 *
 * The agentic variant — the model choosing what to read — is another adapter of this
 * same port, not a rewrite. That is why the seam is here.
 *
 * Golden rule: nothing throws for a value that is absent. It comes back as `null` plus a
 * line in `missingFacts`. A fact that goes missing silently is indistinguishable from a
 * fact that says "no". A bug in our own code is a different thing and is not swallowed.
 */

/** One read's outcome: the value, and whatever gap it left behind. */
interface Read<T> {
  readonly value: T | null;
  readonly missing: readonly string[];
}

export function buildErpFactGatherer(erp: ErpPort): FactGathererPort {
  return {
    async gather(incident: Incident, evaluatedAt: Date, tracer: Tracer): Promise<CaseFacts> {
      const order = await attempt(
        () => erp.fetchOrder(incident.orderId, tracer),
        'order',
        tracer,
      );

      // With no order there is nothing else worth asking: the shipment needs the
      // document type and the history needs the customer document.
      if (order.value === null) {
        return {
          incident,
          evaluatedAt,
          order: null,
          shipment: null,
          history: null,
          notes: [],
          missingFacts: [
            ...order.missing,
            'shipment: not requested, the order is missing',
            'history: not requested, the customer is missing',
          ],
        };
      }

      const [shipment, history, notes] = await Promise.all([
        fetchShipmentOf(erp, order.value, tracer),
        attempt(
          () => erp.fetchHistory(order.value!.customerDoc, evaluatedAt, tracer),
          'history',
          tracer,
        ),
        attemptOr(() => erp.fetchNotes(incident.orderId, tracer), [], 'notes', tracer),
      ]);

      return {
        incident,
        evaluatedAt,
        order: order.value,
        shipment: shipment.value,
        history: history.value,
        notes: notes.value,
        // Fixed order, never completion order. These lines are rendered into the prompt,
        // so letting three concurrent reads decide it by whichever finishes first would
        // change the prompt text — and therefore the cassette hash — between runs of the
        // same case. An eval that is not reproducible measures nothing.
        missingFacts: [
          ...order.missing,
          ...shipment.missing,
          ...history.missing,
          ...notes.missing,
        ],
      };
    },
  };
}

async function fetchShipmentOf(
  erp: ErpPort,
  order: OrderFacts,
  tracer: Tracer,
): Promise<Read<ShipmentFacts>> {
  // The tracking id comes from the order. If the order does not carry one there is no
  // shipment to ask for — and that is said, not papered over by using the order id.
  const trackingId = order.trackingId;
  if (trackingId === null) {
    return { value: null, missing: ['shipment: the order carries no tracking id'] };
  }
  return attempt(() => erp.fetchShipment(trackingId, order.docType, tracer), 'shipment', tracer);
}

/**
 * Runs one read and turns both shapes of "no value" into the same declared thing.
 *
 * The two shapes differ and both matter: `null` is "the ERP answered that it does not
 * exist", an `ErpUnavailableError` is "I could not ask". The reason is written into
 * `missingFacts`, so the difference survives all the way to the report.
 *
 * Anything else — a `TypeError` from our own parsing, a bug in the adapter — is
 * re-thrown. Turning a programming error into "missing fact" would hide it behind a
 * plausible-looking gap, and the guardrails would then be deciding on a lie.
 */
async function attempt<T>(
  read: () => Promise<T | null>,
  label: string,
  tracer: Tracer,
): Promise<Read<T>> {
  try {
    const value = await read();
    return { value, missing: value === null ? [`${label}: SGC does not have it`] : [] };
  } catch (error) {
    if (!(error instanceof ErpUnavailableError)) throw error;
    tracer.mark('error', label, error.message);
    return { value: null, missing: [`${label}: could not be read (${error.message})`] };
  }
}

/** Same as `attempt`, for reads whose empty result is a legitimate value. */
async function attemptOr<T>(
  read: () => Promise<T>,
  fallback: T,
  label: string,
  tracer: Tracer,
): Promise<Read<T> & { readonly value: T }> {
  try {
    return { value: await read(), missing: [] };
  } catch (error) {
    if (!(error instanceof ErpUnavailableError)) throw error;
    tracer.mark('error', label, error.message);
    return { value: fallback, missing: [`${label}: could not be read (${error.message})`] };
  }
}
