import { describe, expect, it } from 'vitest';
import { buildErpFactGatherer } from '../src/adapters/secondary/erp-fact-gatherer';
import { ErpUnavailableError, type ErpPort } from '../src/ports/erp';
import { NULL_TRACER } from '../src/domain/trace';
import { cents } from '../src/domain/money';
import type { Incident } from '../src/domain/incident';
import type { OrderFacts } from '../src/domain/facts';

/**
 * The gatherer is tested against a hand-written fake `ErpPort`: no HTTP, no library
 * mocks. What is proven is its only rule — nothing throws — and that every gap ends up
 * declared in `missingFacts` instead of disappearing.
 */

const INCIDENT: Incident = {
  orderId: 'FC-10241',
  kind: 'damaged',
  customerMessage: 'llego roto',
  reportedAt: new Date('2026-08-30T14:02:00Z'),
  channel: 'email',
};

const EVALUATED_AT = new Date('2026-08-30T15:00:00Z');

const ORDER: OrderFacts = {
  orderId: 'FC-10241',
  docType: 'FC',
  total: cents(4_829_000),
  placedAt: new Date('2026-08-20T12:00:00Z'),
  customerDoc: '20304050',
  trackingId: 'OCA-889',
};

/** Fake ERP: each read is defined per case, anything undefined returns empty. */
function fakeErp(overrides: Partial<ErpPort> = {}): ErpPort {
  return {
    fetchOrder: async () => ORDER,
    fetchShipment: async () => null,
    fetchHistory: async () => null,
    fetchNotes: async () => [],
    ...overrides,
  };
}

describe('buildErpFactGatherer', () => {
  it('asks nothing else without an order, and says why', async () => {
    const gatherer = buildErpFactGatherer(fakeErp({ fetchOrder: async () => null }));
    const facts = await gatherer.gather(INCIDENT, EVALUATED_AT, NULL_TRACER);

    expect(facts.order).toBeNull();
    expect(facts.shipment).toBeNull();
    expect(facts.missingFacts).toHaveLength(3);
    expect(facts.missingFacts.join(' ')).toContain('the order is missing');
  });

  it('a broken ERP does not throw: it becomes a missing fact with the reason', async () => {
    const gatherer = buildErpFactGatherer(
      fakeErp({
        fetchHistory: async () => {
          throw new ErpUnavailableError('history', 'rate limited', 4);
        },
      }),
    );

    const facts = await gatherer.gather(INCIDENT, EVALUATED_AT, NULL_TRACER);

    expect(facts.history).toBeNull();
    expect(facts.missingFacts.join(' ')).toContain('rate limited');
  });

  it('tells apart "the ERP says it does not exist" from "I could not ask"', async () => {
    const gatherer = buildErpFactGatherer(
      fakeErp({
        fetchShipment: async () => null,
        fetchHistory: async () => {
          throw new ErpUnavailableError('history', 'session expired', 4);
        },
      }),
    );

    const facts = await gatherer.gather(INCIDENT, EVALUATED_AT, NULL_TRACER);
    const missing = facts.missingFacts.join(' | ');

    // Both end up as `null`, but the reason survives all the way to the report.
    expect(missing).toContain('shipment: SGC does not have it');
    expect(missing).toContain('history: could not be read');
  });

  it('an order with no tracking id does not invent a shipment number', async () => {
    const gatherer = buildErpFactGatherer(
      fakeErp({
        fetchOrder: async () => ({ ...ORDER, trackingId: null }),
        fetchShipment: async () => {
          throw new Error('should not have been called');
        },
      }),
    );

    const facts = await gatherer.gather(INCIDENT, EVALUATED_AT, NULL_TRACER);

    expect(facts.shipment).toBeNull();
    expect(facts.missingFacts.join(' ')).toContain('carries no tracking id');
  });

  it('the complete case leaves no missing facts', async () => {
    const gatherer = buildErpFactGatherer(
      fakeErp({
        fetchShipment: async () => ({
          trackingId: 'OCA-889',
          state: 'delivered',
          carrier: 'OCA',
          promisedAt: new Date('2026-08-28T12:00:00Z'),
          lastEventAt: new Date('2026-08-29T12:00:00Z'),
        }),
        fetchHistory: async () => ({
          customerDoc: '20304050',
          claimsLast90Days: 0,
          refundedLast90Days: cents(0),
          ordersLast90Days: 4,
        }),
        fetchNotes: async () => ['caja mojada'],
      }),
    );

    const facts = await gatherer.gather(INCIDENT, EVALUATED_AT, NULL_TRACER);

    expect(facts.missingFacts).toEqual([]);
    expect(facts.evaluatedAt).toBe(EVALUATED_AT);
    expect(facts.notes).toEqual(['caja mojada']);
  });
});
