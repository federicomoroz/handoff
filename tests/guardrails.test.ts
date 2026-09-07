import { describe, expect, it } from 'vitest';
import {
  actionAllowlist,
  amountConsistency,
  applyGuardrails,
  confidenceFloor,
  evidenceGrounded,
  GUARDRAILS,
  highValueOrder,
  missingFactsBlock,
  noActionWithoutOrder,
  repeatOffender,
  staleData,
} from '../src/domain/guardrails';
import { cents } from '../src/domain/money';
import type { CaseFacts } from '../src/domain/facts';
import type { Outcome, Proposal } from '../src/domain/decision';

const EVALUATED_AT = new Date('2026-08-30T15:00:00Z');

/** Narrows the union and fails with a useful message if the outcome was not the expected one. */
function asEscalated(outcome: Outcome) {
  if (outcome.kind !== 'escalated') throw new Error(`expected escalated, got ${outcome.kind}`);
  return outcome;
}

/** A healthy case: small order, delivered shipment, customer with no claim history. */
function facts(overrides: Partial<CaseFacts> = {}): CaseFacts {
  return {
    incident: {
      orderId: 'FC-10241',
      kind: 'damaged',
      customerMessage: 'llego roto',
      reportedAt: new Date('2026-08-30T14:02:00Z'),
      channel: 'email',
    },
    evaluatedAt: EVALUATED_AT,
    order: {
      orderId: 'FC-10241',
      docType: 'FC',
      total: cents(4_820_000),
      placedAt: new Date('2026-08-20T12:00:00Z'),
      customerDoc: '20304050',
      trackingId: 'OCA-889',
    },
    shipment: {
      trackingId: 'OCA-889',
      state: 'delivered',
      carrier: 'OCA',
      promisedAt: new Date('2026-08-28T12:00:00Z'),
      lastEventAt: new Date('2026-08-29T12:00:00Z'),
    },
    history: {
      customerDoc: '20304050',
      claimsLast90Days: 0,
      refundedLast90Days: cents(0),
      ordersLast90Days: 4,
    },
    notes: [],
    missingFacts: [],
    ...overrides,
  };
}

/** A proposal that passes all ten. Each test breaks exactly one thing. */
function proposal(overrides: Partial<Proposal> = {}): Proposal {
  return {
    action: 'refund',
    confidence: 0.92,
    amountCents: cents(4_820_000),
    reason: 'the shipment shows as delivered and the customer reported damage in time',
    evidence: ['shipment.state'],
    missingFacts: [],
    ...overrides,
  };
}

describe('confidenceFloor', () => {
  it('lets an unsure agent ask the customer, which is what unsure agents should do', () => {
    // It used to gate this too, and that was backwards: demanding 75% confidence before
    // allowing a question leaves an unsure agent with waking a person as its only legal
    // move. Measured, it turned the right answer into an escalation on every repetition
    // of one case — the model proposed request_evidence at 0.60 and the floor threw it
    // out.
    const unsure = proposal({ action: 'request_evidence', amountCents: null, confidence: 0.4 });
    expect(confidenceFloor(unsure, facts()).ok).toBe(true);
  });

  it('still blocks a refund made without being sure', () => {
    expect(confidenceFloor(proposal({ confidence: 0.5 }), facts()).ok).toBe(false);
  });

  it('blocks anyone who wants to act without being sure', () => {
    expect(confidenceFloor(proposal({ confidence: 0.5 }), facts()).ok).toBe(false);
  });

  it('allows escalating with low confidence: doubting and delegating is correct', () => {
    expect(confidenceFloor(proposal({ action: 'escalate', confidence: 0.1 }), facts()).ok).toBe(
      true,
    );
  });
});

describe('evidenceGrounded', () => {
  it('blocks a citation to a field that is not in the vocabulary', () => {
    const p = proposal({ evidence: ['shipment.karma'] });
    expect(evidenceGrounded(p, facts()).ok).toBe(false);
  });

  it('blocks a citation to a real field this case does not have', () => {
    const p = proposal({ evidence: ['history.claims_90d'] });
    expect(evidenceGrounded(p, facts({ history: null })).ok).toBe(false);
  });

  it('blocks ACTING on no evidence at all', () => {
    expect(evidenceGrounded(proposal({ evidence: [] }), facts()).ok).toBe(false);
  });

  it('lets an uncited question through, for the same reason as the confidence floor', () => {
    // Asking the customer is cheap and undoable. Refusing to let an agent ask until it
    // can cite a fact leaves waking a person as its only legal move when it has little
    // to go on, and that was the single most common way a correct answer became an
    // escalation. Moving money on no stated basis is still blocked.
    const asking = proposal({ action: 'request_evidence', amountCents: null, evidence: [] });
    expect(evidenceGrounded(asking, facts()).ok).toBe(true);
  });

  it('still blocks a refund that states no basis at all', () => {
    expect(evidenceGrounded(proposal({ evidence: [] }), facts()).ok).toBe(false);
  });

  it('still blocks an invented citation whatever the action', () => {
    const asking = proposal({ action: 'request_evidence', amountCents: null, evidence: ['shipment.karma'] });
    expect(evidenceGrounded(asking, facts()).ok).toBe(false);
  });

  it('lets an escalation say it has nothing, because sometimes it has nothing', () => {
    // When the ERP returned no order at all there is no path to cite, and "I have
    // nothing, send it to a person" is the right answer said correctly. Blocking it made
    // a clean escalation impossible on the cases where escalating is most obviously
    // right, and then scored the model down for being honest about an empty hand.
    const empty = proposal({ action: 'escalate', evidence: [] });
    expect(evidenceGrounded(empty, facts({ order: null, shipment: null, history: null })).ok).toBe(
      true,
    );
  });

  it('applies even when the model escalates: an invented citation is never fine', () => {
    const p = proposal({
      action: 'escalate',
      amountCents: null,
      evidence: ['shipment.karma'],
    });
    expect(evidenceGrounded(p, facts()).ok).toBe(false);
  });
});

describe('missingFactsBlock', () => {
  it('blocks anyone who declares missing data and refunds anyway', () => {
    const p = proposal({ missingFacts: ['shipment.promised_at'] });
    expect(missingFactsBlock(p, facts()).ok).toBe(false);
  });

  it('allows requesting evidence, which is exactly the way out for that case', () => {
    const p = proposal({
      action: 'request_evidence',
      amountCents: null,
      missingFacts: ['shipment.promised_at'],
    });
    expect(missingFactsBlock(p, facts()).ok).toBe(true);
  });
});

describe('repeatOffender / highValueOrder', () => {
  it('three claims in 90 days stop the action', () => {
    const f = facts({
      history: {
        customerDoc: '20304050',
        claimsLast90Days: 3,
        refundedLast90Days: cents(100),
        ordersLast90Days: 9,
      },
    });
    expect(repeatOffender(proposal(), f).ok).toBe(false);
  });

  it('an order above the threshold goes to a human even when everything else adds up', () => {
    const f = facts({ order: { ...facts().order!, total: cents(48_290_000) } });
    expect(highValueOrder(proposal({ amountCents: cents(100) }), f).ok).toBe(false);
  });
});

describe('staleData', () => {
  it('blocks anything irreversible when the shipment has been silent for over 72h', () => {
    const f = facts({
      shipment: { ...facts().shipment!, lastEventAt: new Date('2026-08-25T12:00:00Z') },
    });
    expect(staleData(proposal(), f).ok).toBe(false);
  });

  it('does not apply to requesting evidence, which breaks nothing', () => {
    const f = facts({
      shipment: { ...facts().shipment!, lastEventAt: new Date('2026-08-25T12:00:00Z') },
    });
    expect(staleData(proposal({ action: 'request_evidence', amountCents: null }), f).ok).toBe(true);
  });
});

describe('actionAllowlist', () => {
  it('does not refund a shipment that can still move', () => {
    const f = facts({ shipment: { ...facts().shipment!, state: 'in_transit' } });
    expect(actionAllowlist(proposal(), f).ok).toBe(false);
  });

  it('refunds on a terminal state', () => {
    expect(actionAllowlist(proposal(), facts()).ok).toBe(true);
  });
});

describe('amountConsistency', () => {
  it('requires an amount when refunding', () => {
    expect(amountConsistency(proposal({ amountCents: null }), facts()).ok).toBe(false);
  });

  it('does not allow refunding more than the order total', () => {
    expect(amountConsistency(proposal({ amountCents: cents(99_999_999) }), facts()).ok).toBe(false);
  });

  it('rejects a stray amount on an action that carries none', () => {
    const p = proposal({ action: 'reship', amountCents: cents(100) });
    expect(amountConsistency(p, facts()).ok).toBe(false);
  });
});

describe('noActionWithoutOrder', () => {
  it('touches nothing without an order', () => {
    expect(noActionWithoutOrder(proposal(), facts({ order: null })).ok).toBe(false);
  });
});

describe('applyGuardrails', () => {
  it('lets the healthy proposal through and returns all ten verdicts', () => {
    const outcome = applyGuardrails(proposal(), facts());
    expect(outcome.kind).toBe('acted');
    expect(outcome.verdicts).toHaveLength(GUARDRAILS.length);
    expect(outcome.verdicts.every((v) => v.ok)).toBe(true);
  });

  it('evaluates ALL of them and reports the three that failed, not just the first', () => {
    // Low confidence + invented citation + shipment in transit: three different rules.
    const p = proposal({
      confidence: 0.2,
      evidence: ['shipment.karma'],
    });
    const f = facts({ shipment: { ...facts().shipment!, state: 'in_transit' } });

    const outcome = asEscalated(applyGuardrails(p, f));
    expect(outcome.blockedBy).toEqual([
      'confidence-floor',
      'evidence-grounded',
      'action-allowlist',
    ]);
  });

  it('tells apart the model that escalates on its own from the one that was stopped', () => {
    const chose = asEscalated(
      applyGuardrails(proposal({ action: 'escalate', amountCents: null }), facts()),
    );
    expect(chose.escalatedBy).toBe('model');

    const forced = asEscalated(applyGuardrails(proposal({ confidence: 0.1 }), facts()));
    expect(forced.escalatedBy).toBe('guardrail');
  });
});

describe('missing facts (regression)', () => {
  it('does not act when the ERP could not deliver the history', () => {
    // A read that fell over must not look like "this customer has no claims".
    const outcome = applyGuardrails(
      proposal(),
      facts({ history: null, missingFacts: ['history: could not be read (rate limited)'] }),
    );
    expect(outcome.kind).toBe('escalated');
  });

  it('does not act when the shipment is missing', () => {
    const outcome = applyGuardrails(
      // Cites a fact that IS present, so the gap is isolated: without this the test
      // would pass because `evidenceGrounded` rejects the citation instead.
      proposal({ action: 'reship', amountCents: null, evidence: ['order.total'] }),
      facts({ shipment: null, missingFacts: ['shipment: SGC does not have it'] }),
    );
    expect(outcome.kind).toBe('escalated');
  });

  it('does not refund when the shipment has no last event to age', () => {
    const f = facts({ shipment: { ...facts().shipment!, lastEventAt: null } });
    expect(staleData(proposal(), f).ok).toBe(false);
  });
});

/**
 * Every rule is actually enforced, not merely correct.
 *
 * The tests above call each guardrail directly, which proves the rule works and proves
 * nothing about whether anything runs it. That gap was real: deleting `refundCeiling`,
 * `staleData`, `amountConsistency` or `missingFactsBlock` from the list left all 136
 * tests green. Four rules could have been dropped from the net — including the cap on
 * how much money goes back — and the suite would have called it a clean refactor.
 *
 * So each case below is a proposal that this rule, and normally only this rule, should
 * stop, checked through `applyGuardrails`. Other rules may fire too; what matters is
 * that this one is in the report.
 */
describe('the list enforces every rule it contains', () => {
  const CASES: ReadonlyArray<[string, Partial<Proposal>, Partial<CaseFacts>]> = [
    ['confidence-floor', { confidence: 0.5 }, {}],
    // Under the high-value threshold on purpose: the ceiling is what has to stop this.
    ['refund-ceiling', { amountCents: cents(20_000_000) }, { order: { ...facts().order!, total: cents(20_000_000) } }],
    ['evidence-grounded', { evidence: ['shipment.karma'] }, {}],
    ['missing-facts', { missingFacts: ['history: the ERP answered 429'] }, {}],
    ['repeat-offender', {}, { history: { ...facts().history!, claimsLast90Days: 3 } }],
    ['high-value-order', {}, { order: { ...facts().order!, total: cents(40_000_000) } }],
    ['stale-data', {}, { shipment: { ...facts().shipment!, lastEventAt: new Date('2026-08-01T12:00:00Z') } }],
    ['action-allowlist', {}, { shipment: { ...facts().shipment!, state: 'in_transit' } }],
    ['amount-consistency', { amountCents: null }, {}],
    ['no-action-without-order', {}, { order: null }],
    ['facts-complete', {}, { history: null }],
  ];

  it.each(CASES)('reports %s when it is the rule that was broken', (rule, p, f) => {
    const outcome = asEscalated(applyGuardrails(proposal(p), facts(f)));
    expect(outcome.blockedBy).toContain(rule);
    expect(outcome.escalatedBy).toBe('guardrail');
  });

  it('covers every rule in the list, so a new guardrail cannot arrive untested', () => {
    // Taken from a run rather than from a hand-written list: adding a twelfth guardrail
    // without a case above turns this red on the commit that adds it.
    const enforced = applyGuardrails(proposal(), facts()).verdicts.map((v) => v.rule);

    expect(enforced).toHaveLength(GUARDRAILS.length);
    expect([...enforced].sort()).toEqual([...CASES.map(([rule]) => rule)].sort());
  });
});
