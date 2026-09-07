import { describe, expect, it } from 'vitest';
import { buildMocksApp } from '../src/external-mocks/erp-mocks';
import { SGC_HOSTILE, SGC_TAME, type ErpProfile } from '../src/external-mocks/erp-profile';
import { seededDraw } from '../src/external-mocks/draw';
import { BASE_SEED } from '../src/external-mocks/erp-seed';
import { SgcSession } from '../src/adapters/secondary/sgc-session';
import { appTransport } from '../src/core/transport';
import { buildSgcErpAdapter } from '../src/adapters/secondary/sgc-erp-adapter';
import { NULL_TRACER } from '../src/domain/trace';
import type { ErpPort } from '../src/ports/erp';

/**
 * The ERP contract suite.
 *
 * It runs the SAME cases against the hostile profile and the tame one, and demands the
 * same result from both. It is nexo's lesson carried over: one suite verifying several
 * implementations. If a case ever needed an `if` per profile, that would be the signal
 * the hostility is not resolved and the adapter needs fixing, not the test.
 *
 * Randomness is pinned with a seed, so the run is identical every time: a test that
 * fails one day in twenty proves nothing.
 */

const EVALUATED_AT = new Date('2026-08-30T15:00:00Z');

describe.each([
  ['hostile', SGC_HOSTILE],
  ['tame', SGC_TAME],
])('SGC contract — %s profile', (_label, profile: ErpProfile) => {
  /** A fresh app per test: own session, own seed, zero shared state. */
  function erp(): ErpPort {
    const app = buildMocksApp({ profile, seed: BASE_SEED, draw: seededDraw(7) });
    return buildSgcErpAdapter(new SgcSession(appTransport(app)));
  }

  it('reads the order and translates the XML, the amount and the date', async () => {
    const order = await erp().fetchOrder('FC-10241', NULL_TRACER);

    expect(order).not.toBeNull();
    expect(order!.docType).toBe('FC');
    expect(order!.total).toBe(4_829_000);
    expect(order!.customerDoc).toBe('20304050');
    expect(order!.placedAt?.toISOString()).toBe('2026-08-20T12:00:00.000Z');
    // The tracking id comes from the order: that is why the shipment cannot be read first.
    expect(order!.trackingId).toBe('OCA-889');
  });

  it('a non-existent order is null, not an error', async () => {
    expect(await erp().fetchOrder('FC-00000', NULL_TRACER)).toBeNull();
  });

  it('resolves the ambiguous state using the document type from the other endpoint', async () => {
    const adapter = erp();

    // The ERP sends `3` in both. The difference comes from the order's `tipo_doc`.
    const invoice = await adapter.fetchShipment('OCA-889', 'FC', NULL_TRACER);
    const creditNote = await adapter.fetchShipment('OCA-902', 'NC', NULL_TRACER);

    expect(invoice!.state).toBe('delivered');
    expect(creditNote!.state).toBe('cancelled');
  });

  it('normalises the shipment dates to UTC', async () => {
    const shipment = await erp().fetchShipment('OCA-889', 'FC', NULL_TRACER);

    expect(shipment!.carrier).toBe('OCA');
    expect(shipment!.promisedAt?.toISOString()).toBe('2026-08-28T12:00:00.000Z');
    expect(shipment!.lastEventAt?.toISOString()).toBe('2026-08-29T12:00:00.000Z');
  });

  it('pages the history and aggregates the 90-day window', async () => {
    const history = await erp().fetchHistory('27111222', EVALUATED_AT, NULL_TRACER);

    // 30 movements across two pages of 20. The three stale claims fall outside the
    // window: counting rows is not enough, it has to filter by date.
    expect(history!.claimsLast90Days).toBe(5);
    expect(history!.ordersLast90Days).toBe(17);
    expect(history!.refundedLast90Days).toBe(8_800_000);
  });

  it('puts two customers exactly on either side of the repeat-offender threshold', async () => {
    // The rule is `claims >= 3`. With only 0, 1 and 5 claims in the seed, every eval case
    // proves the threshold works for numbers nobody would argue about, and the line
    // itself is never crossed. These two exist so a case can stand on each side of it.
    const adapter = erp();

    expect((await adapter.fetchHistory('30555666', EVALUATED_AT, NULL_TRACER))!.claimsLast90Days)
      .toBe(3);
    expect((await adapter.fetchHistory('24777888', EVALUATED_AT, NULL_TRACER))!.claimsLast90Days)
      .toBe(2);
  });

  it('a customer with no claims gives zero, which is not the same as not knowing', async () => {
    const history = await erp().fetchHistory('20304050', EVALUATED_AT, NULL_TRACER);

    expect(history).not.toBeNull();
    expect(history!.claimsLast90Days).toBe(0);
    expect(history!.ordersLast90Days).toBe(4);
  });

  it('reads the order notes', async () => {
    const notes = await erp().fetchNotes('FC-10241', NULL_TRACER);

    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain('mojada');
  });

  it('an order with no notes returns an empty list', async () => {
    expect(await erp().fetchNotes('FC-10242', NULL_TRACER)).toEqual([]);
  });

  it('notes carry their date, which is the only place epoch dates are exercised', async () => {
    // Hostility 8 declares three date formats. Until the note date was read, the epoch
    // branch of the parser was only ever reached by its own unit test, never by the
    // circuit — a format the ERP really emits and nothing downstream ever consumed.
    const notes = await erp().fetchNotes('FC-10241', NULL_TRACER);

    expect(notes[0]).toContain('2026-08-30T13:40:00.000Z');
    expect(notes[0]).toContain('mojada');
  });

  it('notes for an order that does not exist come back empty, not as an error', async () => {
    expect(await erp().fetchNotes('FC-00000', NULL_TRACER)).toEqual([]);
  });
});

describe.each([
  ['hostile', SGC_HOSTILE],
  ['tame', SGC_TAME],
])('SGC contract — absent values — %s profile', (_label, profile: ErpProfile) => {
  function erp(): ErpPort {
    const app = buildMocksApp({ profile, seed: BASE_SEED, draw: seededDraw(7) });
    return buildSgcErpAdapter(new SgcSession(appTransport(app)));
  }

  it('reads an absent tracking id as null, whichever shape the ERP used to say it', async () => {
    // Hostility 5: the hostile profile rotates between null, "", "N/A", "-" and dropping
    // the key, picked by the die. One seed only exercises one shape, so this sweeps
    // twenty of them — otherwise the test would prove the parser handles whichever
    // shape seed 7 happened to produce, and nothing about the other four.
    // Each seed gets its own app, so they are independent and run concurrently: twenty
    // sequential reads against the hostile profile spend most of their time in its
    // simulated latency.
    const seeds = Array.from({ length: 20 }, (_, i) => i + 1);
    const orders = await Promise.all(
      seeds.map((seed) => {
        const app = buildMocksApp({ profile, seed: BASE_SEED, draw: seededDraw(seed) });
        return buildSgcErpAdapter(new SgcSession(appTransport(app))).fetchOrder(
          'FC-10248',
          NULL_TRACER,
        );
      }),
    );

    for (const order of orders) {
      expect(order).not.toBeNull();
      expect(order!.total).toBe(3_150_000);
      // The failure this guards against is a literal "N/A" or "-" reaching a decision.
      expect(order!.trackingId).toBeNull();
    }
  });

  it('reads absent shipment dates as null rather than as a parsed lie', async () => {
    const shipment = await erp().fetchShipment('AND-475', 'FC', NULL_TRACER);

    expect(shipment!.state).toBe('in_transit');
    expect(shipment!.promisedAt).toBeNull();
    expect(shipment!.lastEventAt).toBeNull();
  });
});
