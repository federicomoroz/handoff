import { describe, expect, it } from 'vitest';
import { joinCases, loadCases, loadLabels, type EvalCase, type EvalLabel } from '../evals/case';
import { applySeedOverrides } from '../evals/seed-overrides';
import { grade, summarise, type TrialRow } from '../evals/grade';
import { loadSuite } from '../evals/runner';
import { FACT_PATHS } from '../src/domain/facts';
import { cents } from '../src/domain/money';
import type { Outcome, Proposal } from '../src/domain/decision';

/**
 * Tier 1: the checks that run on the case files themselves, with no model involved.
 *
 * They are cheap and they catch the failures that make a whole suite meaningless —
 * a duplicated id, a label pointing at a case that was renamed, an override that
 * silently does nothing. None of those show up as a red score; they show up as a suite
 * that looks fine and measures less than it claims.
 */

const CASES = ['evals/cases/escalate.jsonl', 'evals/cases/act.jsonl'].flatMap(loadCases);
const LABELS = loadLabels('evals/labels.jsonl');

describe('the case files', () => {
  it('load, and every case has exactly one label', () => {
    const joined = joinCases(CASES, LABELS);
    expect(joined).toHaveLength(CASES.length);
    expect(CASES.length).toBeGreaterThan(0);
  });

  it('covers both directions', () => {
    // A suite of escalate-only cases cannot tell a careful agent from a useless one:
    // "escalate everything" scores 100% and learns nothing.
    const mustEscalate = LABELS.filter((l) => l.must_escalate).length;
    expect(mustEscalate).toBeGreaterThan(0);
    expect(mustEscalate).toBeLessThan(LABELS.length);
  });

  it('leaves the majority baseline beatable', () => {
    // If "always escalate" already scored 100%, the gate rule that demands the model
    // beat it could never be satisfied by anything, including a perfect agent.
    const baseline =
      LABELS.filter((l) => l.acceptable_actions.includes('escalate')).length / LABELS.length;
    expect(baseline).toBeGreaterThan(0);
    expect(baseline).toBeLessThan(1);
  });

  it('names only facts that exist in the vocabulary', () => {
    // A decisive fact outside FACT_PATHS can never be cited by anyone, so the metric
    // built on it would read 0% forever and look like a model problem.
    for (const label of LABELS) {
      for (const path of label.decisive_facts) {
        expect(Object.keys(FACT_PATHS), `${label.case_id} cites ${path}`).toContain(path);
      }
    }
  });

  it('agrees with itself about escalation', () => {
    for (const label of LABELS) {
      expect(
        label.must_escalate === label.acceptable_actions.every((a) => a === 'escalate'),
        `${label.case_id}: must_escalate and acceptable_actions disagree`,
      ).toBe(true);
    }
  });

  it('refuses a duplicated case id', () => {
    expect(() => joinCases([CASES[0]!, CASES[0]!], LABELS)).toThrow(/duplicate case_id/);
  });

  it('refuses a label with no case, which is how a renamed case stops being measured', () => {
    const orphan: EvalLabel = { ...LABELS[0]!, case_id: 'esc-renamed-away' };
    expect(() => joinCases(CASES, [...LABELS, orphan])).toThrow(/labels with no case/);
  });

  it('refuses a case with no label', () => {
    const unlabelled: EvalCase = { ...CASES[0]!, case_id: 'act-brand-new' };
    expect(() => joinCases([...CASES, unlabelled], LABELS)).toThrow(/case has no label/);
  });

  it('refuses a split that selects nothing', () => {
    expect(() => loadSuite('nonexistent')).toThrow(/nothing would have been measured/);
  });
});

describe('seed overrides', () => {
  it('applies the edit to a copy, leaving the original seed alone', () => {
    const edited = applySeedOverrides({ 'orders.FC-10241.total': '180.000,00' });
    expect(edited.orders['FC-10241']!.total).toBe('180.000,00');
    expect(applySeedOverrides({}).orders['FC-10241']!.total).toBe('48.290,00');
  });

  it('converts a date, so a case does not smuggle a string into a Date field', () => {
    const edited = applySeedOverrides({ 'shipments.AND-441.promesa': '2026-08-27T12:00:00Z' });
    expect(edited.shipments['AND-441']!.promesa).toBeInstanceOf(Date);
  });

  it.each([
    ['orders.FC-99999.total', 'the seed has no order'],
    ['orders.FC-10241.totl', 'no writable field'],
    ['pedidos.FC-10241.total', 'not an overridable collection'],
    ['orders.FC-10241', 'expected <collection>.<id>.<field>'],
  ])('throws on %s rather than doing nothing', (path, message) => {
    // The whole point. An override that no-ops leaves a case running under a name that
    // describes a situation it is not in, still scoring, still claiming coverage.
    expect(() => applySeedOverrides({ [path]: '1' })).toThrow(new RegExp(message));
  });

  it('refuses a value of the wrong type', () => {
    expect(() => applySeedOverrides({ 'shipments.AND-441.estado': 'tres' })).toThrow(
      /expected a number/,
    );
    expect(() => applySeedOverrides({ 'orders.FC-10241.total': null })).toThrow(/null is not/);
  });
});

const label: EvalLabel = {
  case_id: 'esc-x',
  must_escalate: true,
  acceptable_actions: ['escalate'],
  decisive_facts: ['order.total'],
  label_source: 'human-written',
  rationale: 'the amount is over the threshold',
};

function proposal(overrides: Partial<Proposal> = {}): Proposal {
  return {
    action: 'escalate',
    confidence: 0.9,
    amountCents: null,
    reason: 'over the threshold',
    evidence: ['order.total'],
    missingFacts: [],
    ...overrides,
  };
}

const escalated = (p: Proposal): Outcome => ({
  kind: 'escalated',
  proposal: p,
  verdicts: [{ ok: true, rule: 'evidence-grounded' }],
  escalatedBy: 'guardrail',
  blockedBy: ['high-value-order'],
});

const acted = (p: Proposal): Outcome => ({
  kind: 'acted',
  proposal: p,
  verdicts: [{ ok: true, rule: 'evidence-grounded' }],
});

describe('grading', () => {
  it('scores a correct escalation', () => {
    expect(grade(escalated(proposal()), label)).toMatchObject({
      correct_action: true,
      proposal_correct: true,
      correct_escalation: true,
      wrongful_action: false,
      decisive_facts_cited: true,
    });
  });

  it('separates what the net saved from what the model got right', () => {
    // The proposal was a refund on a case that needed a person; a guardrail turned it
    // into an escalation. The system did the right thing and the model did not, and the
    // two numbers have to say so separately.
    const saved = grade(escalated(proposal({ action: 'refund', amountCents: cents(100) })), label);

    expect(saved.correct_action).toBe(true);
    expect(saved.proposal_correct).toBe(false);
    expect(saved.wrongful_action).toBe(true);
  });

  it('counts an act that got through as both wrong and wrongful', () => {
    const through = grade(acted(proposal({ action: 'refund' })), label);

    expect(through.correct_action).toBe(false);
    expect(through.wrongful_action).toBe(true);
  });

  it('does not accept a citation of facts the label never called decisive', () => {
    expect(grade(escalated(proposal({ evidence: ['notes'] })), label).decisive_facts_cited).toBe(
      false,
    );
  });
});

describe('summarising a run', () => {
  const row = (over: Partial<TrialRow> = {}): TrialRow =>
    ({
      case_id: 'esc-x',
      rep: 1,
      status: 'ok',
      decider_id: 'policy:test',
      erp_profile: 'sgc_tame',
      action: 'escalate',
      escalated_by: 'guardrail',
      blocked_by: [],
      confidence: 0.9,
      evidence: ['order.total'],
      missing_facts: [],
      metrics: grade(escalated(proposal()), label),
      duration_ms: 10,
      ...over,
    }) as TrialRow;

  const meta = { run_id: 'r', decider_id: 'd', split: 'test', reps: 1, duration_ms: 1 };

  it('reports null, not zero, when nothing could be scored', () => {
    // Requirement 2, and the reason the null policy exists. A run where the agent never
    // answered has no accuracy; printing 0% says it answered everything wrong, which is
    // a different — and much worse — claim about the same run.
    const failures: TrialRow[] = [
      {
        case_id: 'esc-x',
        rep: 1,
        status: 'failed',
        decider_id: 'policy:null',
        erp_profile: 'sgc_tame',
        failure_class: 'malformed',
        message: 'no decision was produced',
        duration_ms: 5,
      },
    ];
    const summary = summarise(failures, [label], meta);

    expect(summary.scored).toBe(0);
    expect(summary.trials).toBe(1);
    expect(summary.metrics.correct_action).toBeNull();
    expect(summary.metrics.correct_escalation).toBeNull();
    expect(summary.failures.malformed).toBe(1);
  });

  it('keeps failures out of the denominator instead of scoring them as wrong', () => {
    // An ERP that fell over is not the model being wrong. If infrastructure failures
    // counted as zeros, a flaky afternoon would read as a worse model.
    const summary = summarise(
      [
        row(),
        {
          case_id: 'esc-y',
          rep: 1,
          status: 'failed',
          decider_id: 'd',
          erp_profile: 'sgc_hostile',
          failure_class: 'erp_unavailable',
          message: 'the ERP answered 429 four times',
          duration_ms: 3,
        },
      ],
      [label],
      meta,
    );

    expect(summary.trials).toBe(2);
    expect(summary.scored).toBe(1);
    expect(summary.metrics.correct_action).toBe(1);
    expect(summary.failures.erp_unavailable).toBe(1);
  });

  it('counts wrongful actions rather than averaging them', () => {
    const summary = summarise(
      [
        row(),
        row({
          case_id: 'esc-z',
          metrics: grade(acted(proposal({ action: 'refund' })), label),
        }),
      ],
      [label],
      meta,
    );

    expect(summary.wrongful_actions).toBe(1);
  });
});
