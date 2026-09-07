import type { Incident } from '../domain/incident';
import type { CaseFacts } from '../domain/facts';
import type { Outcome, Proposal } from '../domain/decision';
import type { Tracer } from '../domain/trace';

/**
 * The three triage ports.
 *
 * The use case depends on the two below and on nothing else: it does not import the
 * ERP, the LLM, a single tool or a single JSON schema. That is the reason for the split.
 *
 * And it is not a theoretical separation: the eval suite needs to substitute the
 * *judgement* while leaving the ERP reads intact — the oracle, the null policy, the
 * majority policy and the constant policy are four `DecisionMakerPort`s with no model,
 * running against the real ERP. With both concerns in one object that is impossible.
 */

/**
 * Gathers facts from the foreign system.
 *
 * Returns `CaseFacts` with explicit nulls and `missingFacts` filled in. It never throws
 * because a value is missing: that is information, not a failure.
 */
export interface FactGathererPort {
  gather(incident: Incident, evaluatedAt: Date, tracer: Tracer): Promise<CaseFacts>;
}

/**
 * Issues a judgement over already clean facts.
 *
 * Implemented by the model-backed decider and by the four smoke policies. No
 * implementation touches the ERP again: by the time this runs, the hard part of the
 * foreign system is already solved.
 */
export interface DecisionMakerPort {
  /** Identifies who decided: `llm:ollama:qwen3:4b`, `policy:oracle`. */
  readonly id: string;
  propose(facts: CaseFacts, tracer: Tracer): Promise<Proposal>;
}

/** The primary port. Consumed by the HTTP route and the eval runner, and by nobody else. */
export interface TriagePort {
  run(incident: Incident, evaluatedAt: Date, tracer: Tracer): Promise<Outcome>;
}

/**
 * The model answered something that does not validate, or did not call the tool at all.
 *
 * This is a *model* failure, not an infrastructure one, and it is also not a zero on
 * judgement: it has its own metric (`well_formed_decision`). Merging it into either of
 * the other two would make the score meaningless.
 */
export class MalformedDecisionError extends Error {
  constructor(
    readonly backend: string,
    readonly issues: readonly string[],
    readonly raw: string,
  ) {
    super(`${backend}: malformed decision (${issues.join('; ')})`);
    this.name = 'MalformedDecisionError';
  }
}

/**
 * The answer was cut off by the token budget.
 *
 * A truncated answer is not a wrong answer. The eval marks it `truncated`, counts it and
 * shows it, but does not average it in as if the model had decided badly.
 */
export class TruncatedDecisionError extends Error {
  constructor(
    readonly backend: string,
    readonly outputTokens: number,
    /** What it managed to write. An error you cannot diagnose is a bad error. */
    readonly preview: string,
  ) {
    super(`${backend}: the answer was cut off at ${outputTokens} tokens`);
    this.name = 'TruncatedDecisionError';
  }
}
