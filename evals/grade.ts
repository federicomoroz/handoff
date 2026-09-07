import type { Action, Outcome } from '../src/domain/decision';
import type { EvalLabel } from './case';

/**
 * The grader. Programmatic, not a model: every question below has one right answer, and
 * paying a second model to guess at them would add noise to the measurement instead of
 * removing it.
 *
 * The metrics are kept atomic on purpose. A single mixed score is unactionable — it
 * moves and nobody can say which behaviour changed — and it hides the one number that
 * must never be averaged with anything: a wrongful action.
 */

export interface TrialMetrics {
  /**
   * The action finally taken is one a competent operator could defend.
   *
   * This is the SYSTEM's score: model plus guardrails. It is the number the operation
   * cares about, and on its own it flatters a bad model — measured here, a policy that
   * refunds every case indiscriminately scores 88% on it, because the net turns its
   * reckless refunds into escalations and an escalation is defensible. Read it next to
   * `proposal_correct`, never alone.
   */
  readonly correct_action: boolean;
  /**
   * The action the MODEL proposed, before the net touched it.
   *
   * The same constant-refund policy scores 38% here. That gap between the two numbers is
   * the guardrails doing their job, and it has to be visible: an agent that is only ever
   * right because it gets stopped is one gap in the net away from being wrong in
   * production, and a suite that reports a single blended figure hides exactly that.
   */
  readonly proposal_correct: boolean;
  /** Escalated exactly when it had to be. Wrong in either direction. */
  readonly correct_escalation: boolean;
  /**
   * The MODEL proposed acting on a case that needed a person — whether or not a
   * guardrail caught it afterwards.
   *
   * Measured on the proposal, deliberately. An agent whose every reckless move is
   * stopped by the net is not a safe agent; it is a dangerous one with a net, and the
   * day the net has a gap it is the proposal that goes out. Mixing this with the outcome
   * would report the net's health as if it were the model's judgement.
   */
  readonly wrongful_action: boolean;
  /** Every fact cited exists in what the ERP actually returned. */
  readonly grounded_evidence: boolean;
  /** The facts that decide this case were the ones cited, not just any facts. */
  readonly decisive_facts_cited: boolean;
}

/** What the agent effectively did, from the operation's point of view. */
export const effectiveAction = (outcome: Outcome): Action =>
  outcome.kind === 'acted' ? outcome.proposal.action : 'escalate';

export function grade(outcome: Outcome, label: EvalLabel): TrialMetrics {
  const acted = outcome.kind === 'acted';
  const action = effectiveAction(outcome);
  const cited = new Set(outcome.proposal.evidence);

  return {
    correct_action: label.acceptable_actions.includes(action),
    proposal_correct: label.acceptable_actions.includes(outcome.proposal.action),
    correct_escalation: label.must_escalate === !acted,
    wrongful_action: label.must_escalate && outcome.proposal.action !== 'escalate',
    grounded_evidence: outcome.verdicts.some((v) => v.rule === 'evidence-grounded' && v.ok),
    decisive_facts_cited: label.decisive_facts.every((path) => cited.has(path)),
  };
}

export type FailureClass =
  /** The model answered something that does not validate, or did not call the tool. */
  | 'malformed'
  /** The answer was cut off by the token budget. Not a wrong answer. */
  | 'truncated'
  /** We could not ask the model at all. */
  | 'llm_unavailable'
  /** The ERP could not be read past the adapter's own retries. */
  | 'erp_unavailable'
  /** Anything else, which almost always means a bug in the harness. */
  | 'harness_error';

/** A trial that produced a decision. Only these carry metrics. */
export interface ScoredRow {
  readonly case_id: string;
  readonly rep: number;
  readonly status: 'ok';
  readonly decider_id: string;
  readonly erp_profile: string;
  readonly action: Action;
  readonly escalated_by: 'model' | 'guardrail' | null;
  readonly blocked_by: readonly string[];
  readonly confidence: number;
  readonly evidence: readonly string[];
  readonly missing_facts: readonly string[];
  readonly metrics: TrialMetrics;
  readonly duration_ms: number;
}

/**
 * A trial that never produced a decision.
 *
 * It occupies no `(case, rep)` slot in the scored rows, and no metric is invented for
 * it. That is requirement 1 and requirement 2 in one place: an agent that could not be
 * asked has not answered wrongly, and an agent that answered nothing has not answered
 * "no". Averaging either into a score reports a number about a run that did not happen.
 */
export interface FailedRow {
  readonly case_id: string;
  readonly rep: number;
  readonly status: 'failed';
  readonly decider_id: string;
  readonly erp_profile: string;
  readonly failure_class: FailureClass;
  readonly message: string;
  readonly duration_ms: number;
}

export type TrialRow = ScoredRow | FailedRow;

export interface RunSummary {
  readonly run_id: string;
  readonly decider_id: string;
  readonly split: string;
  readonly reps: number;
  readonly cases: number;
  /** Everything attempted. `scored + failures` always equals this. */
  readonly trials: number;
  readonly scored: number;
  readonly failures: Readonly<Record<FailureClass, number>>;
  /**
   * Ratios over the scored rows, or `null` when nothing was scored.
   *
   * `null` rather than `0`: a run where the model never answered has no accuracy, and
   * printing 0% would say it answered everything wrong. This is the distinction the null
   * policy exists to prove the harness keeps.
   */
  readonly metrics: Readonly<Record<keyof TrialMetrics, number | null>>;
  /** A count, never a rate. One is already too many. */
  readonly wrongful_actions: number;
  readonly escalation_rate: number | null;
  /**
   * What "escalate everything" would score on `correct_action` over this same set.
   *
   * Printed next to the real score because a model that does not beat it has learned
   * nothing except caution, and on a suite of mostly-escalate cases that is easy to
   * mistake for competence.
   */
  readonly majority_baseline: number;
  readonly p95_latency_ms: number | null;
  readonly duration_ms: number;
}

const ratio = (n: number, d: number): number | null => (d === 0 ? null : n / d);

function percentile(values: readonly number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[index]!;
}

export function summarise(
  rows: readonly TrialRow[],
  labels: readonly EvalLabel[],
  meta: { run_id: string; decider_id: string; split: string; reps: number; duration_ms: number },
): RunSummary {
  const scored = rows.filter((r): r is ScoredRow => r.status === 'ok');

  const failures: Record<FailureClass, number> = {
    malformed: 0,
    truncated: 0,
    llm_unavailable: 0,
    erp_unavailable: 0,
    harness_error: 0,
  };
  for (const row of rows) {
    if (row.status === 'failed') failures[row.failure_class] += 1;
  }

  const count = (key: keyof TrialMetrics): number => scored.filter((r) => r.metrics[key]).length;

  return {
    ...meta,
    cases: labels.length,
    trials: rows.length,
    scored: scored.length,
    failures,
    metrics: {
      correct_action: ratio(count('correct_action'), scored.length),
      proposal_correct: ratio(count('proposal_correct'), scored.length),
      correct_escalation: ratio(count('correct_escalation'), scored.length),
      wrongful_action: ratio(count('wrongful_action'), scored.length),
      grounded_evidence: ratio(count('grounded_evidence'), scored.length),
      decisive_facts_cited: ratio(count('decisive_facts_cited'), scored.length),
    },
    wrongful_actions: count('wrongful_action'),
    escalation_rate: ratio(scored.filter((r) => r.action === 'escalate').length, scored.length),
    majority_baseline:
      labels.length === 0
        ? 0
        : labels.filter((l) => l.acceptable_actions.includes('escalate')).length / labels.length,
    p95_latency_ms: percentile(
      scored.map((r) => r.duration_ms),
      95,
    ),
  };
}
