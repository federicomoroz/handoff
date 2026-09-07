import { z } from 'zod';
import { cents } from '../../domain/money';
import { FACT_PATHS } from '../../domain/facts';
import type { Proposal } from '../../domain/decision';
import type { LlmToolSpec } from '../../ports/llm';

/**
 * The tool the model uses to issue its judgement, and the translation from what it
 * returns into what the domain understands.
 *
 * The schema is written for what a small model naturally produces, not for what is
 * convenient for the domain. Both differences came from measuring, not guessing:
 *
 *   - `confidence_pct` as an integer 0-100, not a 0-1 decimal. The first probe asked for
 *     0-1 and qwen answered `75`.
 *   - `amount_pesos`, not cents. Asking the model to convert units is asking it to do
 *     arithmetic with exactly one correct answer, which is precisely the work this
 *     project gives to code.
 */

export const DECISION_TOOL_NAME = 'record_decision';

/**
 * Upper bound on the refund the model may name, in pesos.
 *
 * Not a business rule — `REFUND_CEILING` in the domain is that. This is the bound that
 * keeps a nonsense number from becoming an exception: without it, `amount_pesos: 1e308`
 * reaches `cents()` as `Infinity` and throws a `MoneyError` that is neither malformed,
 * nor truncated, nor unavailable, so it escapes unclassified and kills the run.
 */
const MAX_AMOUNT_PESOS = 1_000_000_000;

/** The fact vocabulary, served to the model from the same source that validates citations. */
const FACT_PATH_LIST = Object.keys(FACT_PATHS).join(', ');

const DecisionWireSchema = z.strictObject({
  action: z.enum(['reship', 'refund', 'request_evidence', 'escalate']),
  confidence_pct: z.int().min(0).max(100),
  amount_pesos: z.number().min(0).max(MAX_AMOUNT_PESOS),
  reason: z.string().min(10).max(600),
  /**
   * Named `facts_used` on the wire while the domain calls it `evidence`, because the
   * name was measured to matter.
   *
   * With the field called `evidence`, qwen2.5:3b cited something in 61% of runs. Renamed,
   * with nothing else changed: 100%. The cause is a collision this schema created — one
   * of the four actions is `request_evidence`, meaning "ask the customer for a photo",
   * and the model was conflating that with "list the facts you used". Usable decisions
   * went from 61% to 83% on the same 18 runs.
   *
   * Translating a name the model understands into a name the domain understands is what
   * an adapter is for. Measured with `npx tsx scripts/measure-citations.ts`.
   *
   * A flat array of fact paths, not objects.
   *
   * Measured: qwen2.5:3b returned `"evidence": []` every time when this was an array of
   * `{field, value, source}` objects. It was also the wrong ask — the value and the
   * source are derivable from the path, and deriving them has one correct answer, so it
   * is the code's job. A model that never quotes a value can never misquote one.
   *
   * Deliberately NOT an enum, and deliberately allowed to be empty. The schema checks
   * SHAPE; content is the guardrails' job.
   *
   * Both restrictions would move a content failure into the shape channel: an invented
   * path or an empty list would come back as "malformed decision" instead of as a
   * blocked one, and `grounded_evidence` — a metric whose whole purpose is to count
   * exactly those — would always pass and measure nothing. A metric needs the model to
   * be able to fail in the column that describes the failure.
   */
  facts_used: z.array(z.string().min(1)),
  missing_facts: z.array(z.string()),
});

export const DECISION_TOOL: LlmToolSpec = {
  name: DECISION_TOOL_NAME,
  description:
    'Records the triage decision for the incident. Called exactly once, always, even ' +
    'when the decision is to escalate to a human.',
  inputSchema: {
    ...(z.toJSONSchema(DecisionWireSchema) as Record<string, unknown>),
    description: `Valid paths for facts_used: ${FACT_PATH_LIST}`,
  },
};

export type DecisionParse =
  | { readonly ok: true; readonly proposal: Proposal }
  | { readonly ok: false; readonly issues: readonly string[] };

/**
 * Translates what the tool returned into a `Proposal`.
 *
 * A malformed decision is NOT an exception and NOT a zero: it is its own metric
 * (`well_formed_decision`). That is why this returns a result instead of throwing — the
 * eval runner needs to count them separately rather than mixing them with
 * infrastructure errors.
 *
 * The amount is translated faithfully, without correcting the model: if it sends money
 * on an action that carries none, the value is kept so the `amountConsistency` guardrail
 * can see it and report it. Cleaning it up here would hide the mistake from exactly the
 * component whose job is to catch it.
 */
export function parseDecision(input: unknown): DecisionParse {
  const result = DecisionWireSchema.safeParse(input);
  if (!result.success) {
    return {
      ok: false,
      issues: result.error.issues.map(
        (issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`,
      ),
    };
  }

  const wire = result.data;

  // The schema bounds this, so the throw should be unreachable — which is exactly why
  // it is caught. This function promises a result, never an exception, and a promise
  // that holds only while the schema is right is not a promise.
  let amountCents;
  try {
    amountCents = wire.amount_pesos > 0 ? cents(Math.round(wire.amount_pesos * 100)) : null;
  } catch (error) {
    return { ok: false, issues: [`amount_pesos: ${error instanceof Error ? error.message : error}`] };
  }

  return {
    ok: true,
    proposal: {
      action: wire.action,
      confidence: wire.confidence_pct / 100,
      amountCents,
      reason: wire.reason,
      evidence: wire.facts_used,
      missingFacts: wire.missing_facts,
    } satisfies Proposal,
  };
}
