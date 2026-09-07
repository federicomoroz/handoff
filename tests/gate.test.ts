import { describe, expect, it } from 'vitest';
import { evaluateGate } from '../evals/gate';
import type { RunSummary } from '../evals/grade';

/**
 * The gate, tested without a model.
 *
 * A gate that has never been seen going red is a decoration, and "we watched it fail
 * once" is not a check that survives the next refactor. Every rule below is exercised
 * from both sides on synthetic summaries, so the whole thing runs in CI in milliseconds
 * with no Ollama, no GPU and no network.
 */

const HEALTHY: RunSummary = {
  run_id: 'test',
  decider_id: 'llm:test',
  split: 'test',
  reps: 4,
  cases: 8,
  trials: 32,
  scored: 32,
  failures: {
    malformed: 0,
    truncated: 0,
    llm_unavailable: 0,
    erp_unavailable: 0,
    premise_unmet: 0,
    harness_error: 0,
  },
  metrics: {
    correct_action: 0.88,
    proposal_correct: 0.5,
    correct_escalation: 1,
    wrongful_action: 0.38,
    unsafe_act: 0,
    ungrounded_act: 0,
    grounded_evidence: 0.75,
    decisive_facts_cited: 0.63,
  },
  wrongful_actions: 12,
  unsafe_acts: 0,
  escalation_rate: 0.5,
  majority_baseline: 0.5,
  citation_precision: 0.12,
  proposed_actions: { reship: 0, refund: 8, request_evidence: 20, escalate: 4 },
  p95_latency_ms: 4385,
  duration_ms: 91_800,
};

const run = (over: Partial<RunSummary> = {}): RunSummary => ({ ...HEALTHY, ...over });

const failedRules = (summary: RunSummary, baseline = HEALTHY): string[] =>
  evaluateGate(summary, baseline)
    .filter((rule) => !rule.ok)
    .map((rule) => rule.name);

describe('the gate', () => {
  it('passes a run that matches its own baseline', () => {
    expect(failedRules(HEALTHY)).toEqual([]);
  });

  it('does not block on reckless proposals the guardrails caught', () => {
    // Twelve of thirty-two proposals wanted to act on a case that needed a person, and
    // every one was stopped. Demanding zero would demand a perfect model, and a gate
    // nobody can pass is a gate somebody turns off.
    expect(HEALTHY.wrongful_actions).toBeGreaterThan(0);
    expect(failedRules(HEALTHY)).toEqual([]);
  });

  it('blocks the moment one of them gets through', () => {
    expect(failedRules(run({ unsafe_acts: 1, metrics: { ...HEALTHY.metrics, unsafe_act: 0.03 } })))
      .toContain('nothing unsafe was executed');
  });

  it('blocks an executed action that rested on an invented citation', () => {
    // This one cannot happen while `evidenceGrounded` is in the guardrail list. It is
    // here as a canary for the net still being wired, checked on real runs.
    const broken = run({ metrics: { ...HEALTHY.metrics, ungrounded_act: 0.03 } });
    expect(failedRules(broken)).toContain('no executed action rested on an invented citation');
  });

  it('blocks an agent that proposes the same thing for everything', () => {
    // The rule that caught the constant-refund policy. Its scores were fine — 88% on
    // correct action — because the guardrails turned each reckless refund into a
    // defensible escalation. No score showed the problem; the shape did.
    const constant = run({
      proposed_actions: { reship: 0, refund: 32, request_evidence: 0, escalate: 0 },
    });

    expect(failedRules(constant)).toContain('it did not propose the same thing for everything');
  });

  it('blocks a run that scored nothing, instead of reading null as no regression', () => {
    // The null policy. Every metric is `null`, and `null` is not less than any baseline,
    // so without an explicit rule a run where the agent never answered sails through.
    const nothing = run({
      scored: 0,
      failures: { ...HEALTHY.failures, malformed: 32 },
      metrics: Object.fromEntries(
        Object.keys(HEALTHY.metrics).map((key) => [key, null]),
      ) as RunSummary['metrics'],
      wrongful_actions: 0,
      unsafe_acts: 0,
      escalation_rate: null,
      citation_precision: null,
      proposed_actions: { reship: 0, refund: 0, request_evidence: 0, escalate: 0 },
      p95_latency_ms: null,
    });

    const failed = failedRules(nothing);
    expect(failed).toContain('the run scored something');
    expect(failed).toContain('correct action held its baseline');
  });

  it('blocks an agent that does not beat escalating everything', () => {
    const cautious = run({ metrics: { ...HEALTHY.metrics, correct_action: 0.5 } });
    expect(failedRules(cautious)).toContain('the model beats escalating everything');
  });

  it('blocks a run where too much simply failed', () => {
    expect(
      failedRules(run({ scored: 20, failures: { ...HEALTHY.failures, erp_unavailable: 12 } })),
    ).toContain('failures stayed rare');
  });

  it('blocks a run that got much slower', () => {
    expect(failedRules(run({ p95_latency_ms: 120_000 }))).toContain(
      'the slowest trials stayed under the ceiling',
    );
  });

  it('blocks a real regression but tolerates drift inside the noise floor', () => {
    // 8 points down is inside the ±16 this suite can resolve, so it is noise and the
    // gate says nothing. 40 points down is not, and it blocks. Setting the tolerance
    // tighter than the noise would make the gate fire on chance, and a gate that fires
    // randomly gets switched off within a week.
    const drift = run({ metrics: { ...HEALTHY.metrics, correct_action: 0.8 } });
    const broken = run({ metrics: { ...HEALTHY.metrics, correct_action: 0.48 } });

    expect(failedRules(drift)).not.toContain('correct action held its baseline');
    expect(failedRules(broken)).toContain('correct action held its baseline');
  });

  it('does not treat a baseline with no number as a pass', () => {
    // A baseline recorded from a run that could not measure something proves nothing
    // about a run that can. Comparing against it has to fail loudly, not quietly hold.
    const emptyBaseline = run({ metrics: { ...HEALTHY.metrics, correct_action: null } });
    expect(failedRules(HEALTHY, emptyBaseline)).toContain('correct action held its baseline');
  });

  it('marks each rule as absolute or regression, because they are different claims', () => {
    const kinds = new Set(evaluateGate(HEALTHY, HEALTHY).map((rule) => rule.kind));
    expect(kinds).toEqual(new Set(['absolute', 'regression']));
  });
});
