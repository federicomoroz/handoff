import { describe, expect, it } from 'vitest';
import { buildTriageStack } from '../src/composition';
import { SGC_HOSTILE, SGC_TAME } from '../src/external-mocks/erp-profile';
import { seededDraw } from '../src/external-mocks/draw';
import { TraceRecorder } from '../src/domain/trace';
import { cents } from '../src/domain/money';
import type { CaseFacts } from '../src/domain/facts';
import type { Proposal } from '../src/domain/decision';
import type { DecisionMakerPort } from '../src/ports/triage';
import type { Incident } from '../src/domain/incident';

/**
 * The whole circuit, assembled by `composition.ts`: simulated ERP -> session -> adapter
 * -> gatherer -> use case -> guardrails.
 *
 * The judgement comes from a fake decider, so the suite runs with no model, no GPU and
 * in milliseconds. It is exactly the mechanism the eval's four smoke policies will use:
 * the `DecisionMakerPort`, substituted.
 */

const EVALUATED_AT = new Date('2026-08-30T15:00:00Z');

function incident(orderId: string): Incident {
  return {
    orderId,
    kind: 'damaged',
    customerMessage: 'llego roto',
    reportedAt: new Date('2026-08-30T14:02:00Z'),
    channel: 'email',
  };
}

/** Test decider: returns whatever it is told and records the facts it saw. */
function fakeDecider(build: (facts: CaseFacts) => Proposal): DecisionMakerPort & {
  seen: CaseFacts[];
} {
  const seen: CaseFacts[] = [];
  return {
    id: 'policy:fake',
    seen,
    async propose(facts) {
      seen.push(facts);
      return build(facts);
    },
  };
}

const REFUND = (facts: CaseFacts): Proposal => ({
  action: 'refund',
  confidence: 0.92,
  amountCents: facts.order?.total ?? cents(0),
  reason: 'the shipment shows as delivered and the customer reported damage in time',
  evidence: ['shipment.state'],
  missingFacts: [],
});

function stackWith(decider: DecisionMakerPort, profile = SGC_HOSTILE) {
  return buildTriageStack({ profile, draw: seededDraw(7), decider });
}

describe('the complete circuit', () => {
  it('gathers facts from the hostile ERP and allows acting when everything adds up', async () => {
    const decider = fakeDecider(REFUND);
    const outcome = await stackWith(decider).triage.run(
      incident('FC-10241'),
      EVALUATED_AT,
      new TraceRecorder(),
    );

    // The facts arrived clean: none of the ten hostilities crossed the port.
    const facts = decider.seen[0]!;
    expect(facts.order?.total).toBe(4_829_000);
    expect(facts.shipment?.state).toBe('delivered');
    expect(facts.history?.claimsLast90Days).toBe(0);
    expect(facts.missingFacts).toEqual([]);

    expect(outcome.kind).toBe('acted');
  });

  it('gives the same result against the tame ERP', async () => {
    const outcome = await stackWith(fakeDecider(REFUND), SGC_TAME).triage.run(
      incident('FC-10241'),
      EVALUATED_AT,
      new TraceRecorder(),
    );

    expect(outcome.kind).toBe('acted');
  });

  it('the guardrails stop a decider that wants to refund an expensive order', async () => {
    // FC-10244 is 612,400 pesos: above the threshold, it goes to a human regardless.
    const outcome = await stackWith(fakeDecider(REFUND)).triage.run(
      incident('FC-10244'),
      EVALUATED_AT,
      new TraceRecorder(),
    );

    expect(outcome.kind).toBe('escalated');
    if (outcome.kind !== 'escalated') return;
    expect(outcome.escalatedBy).toBe('guardrail');
    expect(outcome.blockedBy).toContain('high-value-order');
  });

  it('the guardrails stop a customer with a claim history', async () => {
    const outcome = await stackWith(fakeDecider(REFUND)).triage.run(
      incident('FC-10245'),
      EVALUATED_AT,
      new TraceRecorder(),
    );

    expect(outcome.kind).toBe('escalated');
    if (outcome.kind !== 'escalated') return;
    expect(outcome.blockedBy).toContain('repeat-offender');
  });

  it('a non-existent order reaches the decider as a missing fact, not an exception', async () => {
    const decider = fakeDecider(REFUND);
    const outcome = await stackWith(decider).triage.run(
      incident('FC-00000'),
      EVALUATED_AT,
      new TraceRecorder(),
    );

    expect(decider.seen[0]!.order).toBeNull();
    expect(decider.seen[0]!.missingFacts.length).toBeGreaterThan(0);
    // And with no order, acting is blocked.
    expect(outcome.kind).toBe('escalated');
    if (outcome.kind !== 'escalated') return;
    expect(outcome.blockedBy).toContain('no-action-without-order');
  });

  it('leaves a trace of the layers it went through', async () => {
    const tracer = new TraceRecorder();
    await stackWith(fakeDecider(REFUND)).triage.run(incident('FC-10241'), EVALUATED_AT, tracer);

    const steps = tracer.entries.map((e) => e.step);
    expect(steps[0]).toBe('input');
    expect(steps).toContain('erp');
    expect(steps.at(-1)).toBe('output');
  });
});
