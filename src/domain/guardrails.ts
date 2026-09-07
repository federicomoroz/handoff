import { cents, compareCents, formatArs, type Cents } from './money';
import { FACT_PATHS, presentFactPaths, TERMINAL_SHIPMENT_STATES, type CaseFacts } from './facts';
import { isActing, type GuardrailVerdict, type Outcome, type Proposal } from './decision';
import { HOUR_MS } from './time';

/**
 * The guardrails: the third leg of the thesis, "knowing when not to let it act".
 *
 * They are pure functions — same input, same output, no network, no clock, no state —
 * so the whole set is tested without spending a cent of API. Each does one thing and is
 * added without touching the others.
 *
 * The same thresholds also live in the prompt. That is defence in depth on purpose: the
 * prompt makes the model right more often, the guardrails make its mistakes harmless.
 * Each layer is measured separately in the evals.
 *
 * They all fail CLOSED: when a rule cannot evaluate because the fact it needs is
 * missing, it blocks. A guardrail that passes on ignorance is worse than no guardrail,
 * because it looks like a check.
 */

/** Below this the model does not know enough to act on its own. */
export const CONFIDENCE_FLOOR = 0.75;

/** Automatic refund ceiling: ARS 150,000.00. */
export const REFUND_CEILING: Cents = cents(15_000_000);

/** An order above ARS 300,000.00 goes to a human whatever the model decides. */
export const HIGH_VALUE_ORDER: Cents = cents(30_000_000);

/** Three claims in 90 days stops being bad luck. */
export const REPEAT_OFFENDER_CLAIMS = 3;

/** A shipment with no news for longer than this cannot support an irreversible action. */
export const STALE_FACT_HOURS = 72;

export type Guardrail = (proposal: Proposal, facts: CaseFacts) => GuardrailVerdict;

const pass = (rule: string): GuardrailVerdict => ({ ok: true, rule });
const block = (rule: string, reason: string): GuardrailVerdict => ({ ok: false, rule, reason });

/** 1. Low confidence plus an urge to act is the combination worth stopping. */
export const confidenceFloor: Guardrail = (p) => {
  const rule = 'confidence-floor';
  if (!isActing(p.action)) return pass(rule);
  return p.confidence >= CONFIDENCE_FLOOR
    ? pass(rule)
    : block(rule, `confidence ${p.confidence.toFixed(2)} below floor ${CONFIDENCE_FLOOR}`);
};

/** 2. How much money can go back without anyone looking at it. */
export const refundCeiling: Guardrail = (p) => {
  const rule = 'refund-ceiling';
  if (p.action !== 'refund' || p.amountCents === null) return pass(rule);
  return compareCents(p.amountCents, REFUND_CEILING) <= 0
    ? pass(rule)
    : block(rule, `${formatArs(p.amountCents)} is over the ceiling ${formatArs(REFUND_CEILING)}`);
};

/**
 * 3. Anti-hallucination: every citation must point at a fact the ERP actually returned.
 * The only guardrail that does not depend on the action — an invented citation is a
 * problem even when the model ends up escalating.
 */
export const evidenceGrounded: Guardrail = (p, f) => {
  const rule = 'evidence-grounded';
  if (p.evidence.length === 0) return block(rule, 'cited no facts at all');

  const present = presentFactPaths(f);
  for (const path of p.evidence) {
    if (!(path in FACT_PATHS)) {
      return block(rule, `cited "${path}", which is not in the fact vocabulary`);
    }
    if (!present.has(path)) {
      return block(rule, `cited "${path}", which this case does not have`);
    }
  }
  return pass(rule);
};

/** 4. If the model itself says facts are missing, it cannot act on the gap. */
export const missingFactsBlock: Guardrail = (p) => {
  const rule = 'missing-facts';
  if (!isActing(p.action) || p.action === 'request_evidence') return pass(rule);
  return p.missingFacts.length === 0
    ? pass(rule)
    : block(rule, `declared missing [${p.missingFacts.join(', ')}] and still wanted to ${p.action}`);
};

/** 5. Three claims in 90 days is a pattern, and patterns get a human. */
export const repeatOffender: Guardrail = (p, f) => {
  const rule = 'repeat-offender';
  if (!isActing(p.action) || f.history === null) return pass(rule);
  return f.history.claimsLast90Days < REPEAT_OFFENDER_CLAIMS
    ? pass(rule)
    : block(rule, `${f.history.claimsLast90Days} claims in 90 days`);
};

/** 6. Above the value threshold, always a human. */
export const highValueOrder: Guardrail = (p, f) => {
  const rule = 'high-value-order';
  if (!isActing(p.action) || f.order === null) return pass(rule);
  return compareCents(f.order.total, HIGH_VALUE_ORDER) <= 0
    ? pass(rule)
    : block(rule, `order of ${formatArs(f.order.total)} is over ${formatArs(HIGH_VALUE_ORDER)}`);
};

/**
 * 7. A shipment silent for three days does not support anything irreversible.
 *
 * Fails CLOSED: no last event means the age is unknown, and an unknown age is not a
 * fresh one. A date in the future is worse than useless, so it blocks too.
 */
export const staleData: Guardrail = (p, f) => {
  const rule = 'stale-data';
  if (p.action !== 'refund' && p.action !== 'reship') return pass(rule);

  const lastEvent = f.shipment?.lastEventAt;
  if (!lastEvent) return block(rule, 'no last shipment event to measure staleness against');

  const ageHours = (f.evaluatedAt.getTime() - lastEvent.getTime()) / HOUR_MS;
  if (ageHours < 0) return block(rule, `last event is ${(-ageHours).toFixed(0)}h in the future`);

  return ageHours <= STALE_FACT_HOURS
    ? pass(rule)
    : block(rule, `last event ${ageHours.toFixed(0)}h ago, limit ${STALE_FACT_HOURS}h`);
};

/** 8. A shipment that can still move does not get refunded. */
export const actionAllowlist: Guardrail = (p, f) => {
  const rule = 'action-allowlist';
  if (p.action !== 'refund') return pass(rule);
  if (f.shipment === null) return block(rule, 'refund without shipment data');
  return TERMINAL_SHIPMENT_STATES.includes(f.shipment.state)
    ? pass(rule)
    : block(rule, `shipment is "${f.shipment.state}", which is not a terminal state`);
};

/** 9. The amount must be present when it applies, absent when it does not, and fit the order. */
export const amountConsistency: Guardrail = (p, f) => {
  const rule = 'amount-consistency';
  if (p.action === 'refund') {
    if (p.amountCents === null) return block(rule, 'refund without an amount');
    if (f.order && compareCents(p.amountCents, f.order.total) > 0) {
      return block(
        rule,
        `refund of ${formatArs(p.amountCents)} on an order of ${formatArs(f.order.total)}`,
      );
    }
    return pass(rule);
  }
  return p.amountCents === null
    ? pass(rule)
    : block(rule, `${p.action} carries no amount and brought ${formatArs(p.amountCents)}`);
};

/** 10. No order, no case: if the ERP did not return it, nothing gets touched. */
export const noActionWithoutOrder: Guardrail = (p, f) => {
  const rule = 'no-action-without-order';
  if (!isActing(p.action)) return pass(rule);
  return f.order !== null ? pass(rule) : block(rule, 'the ERP did not return the order');
};

/**
 * 11. Nothing gets decided on top of a hole.
 *
 * This is the rule that makes the whole set fail CLOSED, and it exists because the set
 * did not. Every other guardrail asks "is this fact bad?"; none of them asked "is this
 * fact there?", so a read that fell over looked exactly like good news — a customer with
 * no claim history and a shipment with nothing wrong.
 *
 * Measured before the fix: with the hostile ERP, one run in twenty refunded a customer
 * with five claims in 90 days, because the history read hit a 429 and came back `null`.
 * The gatherer preserved the distinction in `missingFacts` and this layer threw it away.
 *
 * `request_evidence` is exempt: asking the customer for what is missing is the correct
 * response to a gap, not an action taken on top of one.
 */
export const factsComplete: Guardrail = (p, f) => {
  const rule = 'facts-complete';
  if (!isActing(p.action) || p.action === 'request_evidence') return pass(rule);

  const gaps: string[] = [];
  if (f.order === null) gaps.push('order');
  if (f.shipment === null) gaps.push('shipment');
  if (f.history === null) gaps.push('history');

  return gaps.length === 0
    ? pass(rule)
    : block(rule, `would ${p.action} without ${gaps.join(', ')}`);
};

/** Report order, not execution order: all of them always run. */
export const GUARDRAILS: readonly Guardrail[] = [
  confidenceFloor,
  refundCeiling,
  evidenceGrounded,
  missingFactsBlock,
  repeatOffender,
  highValueOrder,
  staleData,
  actionAllowlist,
  amountConsistency,
  noActionWithoutOrder,
  factsComplete,
];

/**
 * Runs every guardrail and assembles the outcome.
 *
 * Every guardrail is evaluated; there is no short-circuit on the first block. Stopping
 * early would give the same decision but lose the diagnosis, and the report has to be
 * able to name the three rules that fired, not just the first one.
 */
export function applyGuardrails(proposal: Proposal, facts: CaseFacts): Outcome {
  const verdicts = GUARDRAILS.map((guardrail) => guardrail(proposal, facts));
  const blockedBy = verdicts.filter((v) => !v.ok).map((v) => v.rule);

  if (!isActing(proposal.action)) {
    return { kind: 'escalated', proposal, verdicts, escalatedBy: 'model', blockedBy };
  }
  if (blockedBy.length > 0) {
    return { kind: 'escalated', proposal, verdicts, escalatedBy: 'guardrail', blockedBy };
  }
  return { kind: 'acted', proposal, verdicts };
}
