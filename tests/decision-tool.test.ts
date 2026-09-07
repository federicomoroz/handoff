import { describe, expect, it } from 'vitest';
import { DECISION_TOOL, parseDecision } from '../src/adapters/secondary/decision-tool';
import { FACT_PATHS } from '../src/domain/facts';

/** A valid decision. Each test breaks exactly one thing. */
function wire(overrides: Record<string, unknown> = {}) {
  return {
    action: 'refund',
    confidence_pct: 92,
    amount_pesos: 48290,
    reason: 'the shipment shows as delivered and the customer reported damage in time',
    facts_used: ['shipment.state'],
    missing_facts: [],
    ...overrides,
  };
}

describe('the tool schema', () => {
  it('closes the object, which is what strict mode requires', () => {
    const schema = DECISION_TOOL.inputSchema;
    expect(schema['type']).toBe('object');
    expect(schema['additionalProperties']).toBe(false);
    expect(schema['required']).toEqual(
      expect.arrayContaining(['action', 'confidence_pct', 'amount_pesos', 'reason', 'facts_used']),
    );
  });

  it('tells the model the valid paths instead of constraining them with an enum', () => {
    // Constraining them would make citing an invented fact impossible, and
    // `grounded_evidence` would always pass. A metric needs the model to be able to fail.
    const description = String(DECISION_TOOL.inputSchema['description']);
    for (const path of Object.keys(FACT_PATHS)) {
      expect(description).toContain(path);
    }
  });
});

describe('parseDecision', () => {
  it('converts percentage to fraction and pesos to cents', () => {
    const parsed = parseDecision(wire());

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.proposal.confidence).toBeCloseTo(0.92);
    expect(parsed.proposal.amountCents).toBe(4_829_000);
  });

  it('rounds cents instead of truncating them', () => {
    // 1537.5 passes under `Math.trunc` too, so it proves nothing on its own. 0.005 is
    // the value that separates rounding from truncation, and it is a real half-cent
    // difference on someone's refund.
    expect(parseDecision(wire({ amount_pesos: 1537.5 })).ok).toBe(true);

    const rounded = parseDecision(wire({ amount_pesos: 10.005 }));
    if (!rounded.ok) throw new Error('should have parsed');
    expect(rounded.proposal.amountCents).toBe(1001);
  });

  it('amount 0 means "not applicable", not a refund of zero', () => {
    const parsed = parseDecision(wire({ action: 'escalate', amount_pesos: 0 }));
    if (!parsed.ok) throw new Error('should have parsed');
    expect(parsed.proposal.amountCents).toBeNull();
  });

  it('keeps a stray amount on an action that carries none, so the guardrail can see it', () => {
    // Cleaning it up here would hide the mistake from the component meant to catch it.
    const parsed = parseDecision(wire({ action: 'reship', amount_pesos: 500 }));
    if (!parsed.ok) throw new Error('should have parsed');
    expect(parsed.proposal.amountCents).toBe(50_000);
  });

  it('accepts a citation to an invented field: the guardrail judges that, not the schema', () => {
    const parsed = parseDecision(wire({ facts_used: ['shipment.karma'] }));
    expect(parsed.ok).toBe(true);
  });
});

describe('malformed decisions', () => {
  it('returns a result rather than throwing: it is its own metric', () => {
    const parsed = parseDecision(wire({ confidence_pct: 150 }));

    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.issues.join(' ')).toContain('confidence_pct');
  });

  it('rejects an action that does not exist', () => {
    expect(parseDecision(wire({ action: 'ignore' })).ok).toBe(false);
  });

  it('accepts an empty facts_used list: that is a content failure, not a shape one', () => {
    // `evidenceGrounded` blocks it and `grounded_evidence` counts it. Rejecting it here
    // would file a content failure under "malformed" and leave that metric measuring
    // nothing.
    expect(parseDecision(wire({ facts_used: [] })).ok).toBe(true);
  });

  it('rejects extra fields, which catches the model that invents structure', () => {
    expect(parseDecision(wire({ priority: 'high' })).ok).toBe(false);
  });

  it('rejects anything that is not an object', () => {
    expect(parseDecision(null).ok).toBe(false);
    expect(parseDecision('escalate').ok).toBe(false);
  });
});

describe('absurd amounts (regression)', () => {
  it('rejects an amount that would overflow instead of throwing', () => {
    // `cents()` throws on Infinity. This function promises a result, never an exception:
    // an escaped MoneyError is neither malformed, truncated nor unavailable, so the eval
    // runner could not classify it and the run would die.
    for (const amount of [1e308, 1e15, Number.MAX_VALUE]) {
      const parsed = parseDecision(wire({ amount_pesos: amount }));
      expect(parsed.ok).toBe(false);
    }
  });
});
