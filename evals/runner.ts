import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildTriageStack } from '../src/composition';
import { SGC_HOSTILE, SGC_TAME } from '../src/external-mocks/erp-profile';
import { seededDraw } from '../src/external-mocks/draw';
import { TraceRecorder } from '../src/domain/trace';
import { presentFactPaths } from '../src/domain/facts';
import { ErpUnavailableError } from '../src/ports/erp';
import { LlmUnavailableError } from '../src/ports/llm';
import {
  MalformedDecisionError,
  TruncatedDecisionError,
  type DecisionMakerPort,
} from '../src/ports/triage';
import { joinCases, loadCases, loadLabels, toIncident, type LabelledCase } from './case';
import { applySeedOverrides } from './seed-overrides';
import {
  citationPrecision,
  effectiveAction,
  grade,
  summarise,
  type FailureClass,
  type RunSummary,
  type TrialRow,
} from './grade';
import {
  buildPolicy,
  SMOKE_EXPECTATIONS,
  SMOKE_POLICIES,
  type SmokeFacts,
  type SmokePolicy,
} from './policies';

/**
 * The eval runner: one primary adapter over the same use case the HTTP route drives.
 *
 * It builds nothing itself. Every trial goes through `buildTriageStack`, which is what
 * makes the number it reports a number about the agent that ships — an eval that wires
 * its own agent measures its own agent, and the architecture test fails on the commit
 * that tries.
 *
 * What it DOES own is the scenario: which ERP profile, which seed edits, which die and
 * which clock. All four are pinned per trial, from a hash of `(case_id, rep)`, so a red
 * result can be re-run instead of explained away as a bad day.
 *
 * That holds even where it looked like it might not. The simulated ERP expires its
 * session by counting requests while the shipment, the history and the notes are read in
 * parallel, and the retry backoff waits on real timers — enough moving parts that the
 * same trial landing in `premise_unmet` on one run and not another would be entirely
 * believable. It was checked rather than assumed: seven consecutive runs of the same
 * configuration starve the same trial, `act-just-under-stale.2`, every time.
 */

const CASE_FILES = ['evals/cases/escalate.jsonl', 'evals/cases/act.jsonl'];
const LABEL_FILE = 'evals/labels.jsonl';

export interface RunOptions {
  readonly split: string;
  readonly reps: number;
  readonly outDir: string;
  /** A smoke policy, or `null` to run the backend the composition root chooses. */
  readonly policy: SmokePolicy | null;
}

/**
 * A stable die per trial.
 *
 * Derived from the case id and the repetition rather than from a counter, so trial 5
 * draws the same numbers whether it ran alone, after a failure, or in a different order.
 * FNV-1a because it has to be stable across processes, not because it has to be good.
 */
function trialSeed(caseId: string, rep: number): number {
  let hash = 2_166_136_261;
  for (const char of `${caseId}:${rep}`) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16_777_619);
  }
  return hash >>> 0;
}

function classify(error: unknown): { failure_class: FailureClass; message: string } {
  if (error instanceof MalformedDecisionError) {
    return { failure_class: 'malformed', message: error.message };
  }
  if (error instanceof TruncatedDecisionError) {
    return { failure_class: 'truncated', message: error.message };
  }
  if (error instanceof LlmUnavailableError) {
    return { failure_class: 'llm_unavailable', message: error.message };
  }
  if (error instanceof ErpUnavailableError) {
    return { failure_class: 'erp_unavailable', message: error.message };
  }
  // Anything unrecognised is the harness's own fault until proven otherwise. Filing it
  // under a model failure would let a bug in here quietly lower the model's score.
  return {
    failure_class: 'harness_error',
    message: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
  };
}

interface Trial {
  readonly row: TrialRow;
  readonly trajectory: unknown;
}

async function runTrial(
  { evalCase, label }: LabelledCase,
  rep: number,
  options: RunOptions,
): Promise<Trial> {
  const decider: DecisionMakerPort | undefined = options.policy
    ? buildPolicy(options.policy, label)
    : undefined;

  const stack = buildTriageStack({
    profile: evalCase.erp_profile === 'sgc_hostile' ? SGC_HOSTILE : SGC_TAME,
    seed: applySeedOverrides(evalCase.erp_seed_overrides),
    draw: seededDraw(trialSeed(evalCase.case_id, rep)),
    // A repetition that does not vary the model seed counts one run several times: at
    // temperature 0 the same seed returns the same answer.
    ...(decider ? { decider } : { llmSeed: rep }),
  });

  const tracer = new TraceRecorder();
  const startedAt = Date.now();
  const common = {
    case_id: evalCase.case_id,
    rep,
    decider_id: stack.deciderId,
    erp_profile: evalCase.erp_profile,
  };
  const context = {
    ...common,
    evaluated_at: evalCase.evaluated_at,
    incident: evalCase.incident,
    seed_overrides: evalCase.erp_seed_overrides,
  };

  try {
    const outcome = await stack.triage.run(
      toIncident(evalCase),
      new Date(evalCase.evaluated_at),
      tracer,
    );

    // Did this trial get to test what it says it tests? The hostile ERP can starve a
    // read past every retry, and when the starved fact is the one the label calls
    // decisive, the case is no longer the case. Scoring it anyway punishes the agent for
    // answering a question it was never actually asked.
    const present = presentFactPaths(outcome.facts);
    const unmet = label.decisive_facts.filter((path) => !present.has(path));
    if (unmet.length > 0) {
      const message = `the ERP never delivered ${unmet.join(', ')}, which this case turns on`;
      return {
        row: {
          ...common,
          status: 'failed',
          failure_class: 'premise_unmet',
          message,
          duration_ms: Date.now() - startedAt,
        },
        trajectory: {
          ...context,
          trace: tracer.entries,
          facts: outcome.facts,
          proposal: outcome.proposal,
          verdicts: outcome.verdicts,
          failure_class: 'premise_unmet',
          message,
          label,
        },
      };
    }

    const metrics = grade(outcome, label);

    return {
      row: {
        ...common,
        status: 'ok',
        action: effectiveAction(outcome),
        proposed_action: outcome.proposal.action,
        escalated_by: outcome.kind === 'escalated' ? outcome.escalatedBy : null,
        blocked_by: outcome.kind === 'escalated' ? outcome.blockedBy : [],
        confidence: outcome.proposal.confidence,
        evidence: outcome.proposal.evidence,
        missing_facts: outcome.proposal.missingFacts,
        metrics,
        citation_precision: citationPrecision(outcome, label),
        duration_ms: Date.now() - startedAt,
      },
      // Everything needed to argue with the result later, including what the grader was
      // given. A trajectory that omits the label lets nobody check the label.
      trajectory: {
        ...context,
        trace: tracer.entries,
        // What the agent actually read. A trajectory with the verdict and not the
        // evidence cannot tell bad reasoning from a hole in the data.
        facts: outcome.facts,
        proposal: outcome.proposal,
        verdicts: outcome.verdicts,
        outcome_kind: outcome.kind,
        label,
        metrics,
      },
    };
  } catch (error) {
    const classified = classify(error);

    return {
      row: {
        ...common,
        status: 'failed',
        ...classified,
        duration_ms: Date.now() - startedAt,
      },
      trajectory: { ...context, trace: tracer.entries, ...classified, label },
    };
  }
}

export function loadSuite(split: string): LabelledCase[] {
  const cases = CASE_FILES.flatMap((file) => loadCases(file));
  const joined = joinCases(cases, loadLabels(LABEL_FILE));
  const selected = joined.filter(({ evalCase }) => evalCase.split === split);

  // A run over nothing succeeds at everything. Without this a typo in `--split` reports
  // a clean sheet, and a gate built on it goes green over zero evidence.
  if (selected.length === 0) {
    throw new Error(`no cases in split "${split}" — nothing would have been measured`);
  }
  return selected;
}

export async function runEval(options: RunOptions): Promise<RunSummary> {
  const suite = loadSuite(options.split);
  const runId = `${new Date().toISOString().replace(/[:.]/g, '-')}-${options.policy ?? 'model'}`;
  const dir = join(options.outDir, runId);
  mkdirSync(join(dir, 'trajectories'), { recursive: true });

  const rows: TrialRow[] = [];
  const startedAt = Date.now();

  for (let rep = 1; rep <= options.reps; rep++) {
    for (const labelled of suite) {
      const { row, trajectory } = await runTrial(labelled, rep, options);
      rows.push(row);
      writeFileSync(
        join(dir, 'trajectories', `${labelled.evalCase.case_id}.${rep}.json`),
        JSON.stringify(trajectory, null, 2),
      );
      process.stdout.write(row.status === 'ok' ? '.' : '!');
    }
  }

  const summary = summarise(
    rows,
    suite.map((s) => s.label),
    {
      run_id: runId,
      decider_id: rows[0]?.decider_id ?? 'unknown',
      split: options.split,
      reps: options.reps,
      duration_ms: Date.now() - startedAt,
    },
  );

  // Scored rows and failures go to different files, so no reader has to remember which
  // rows were real. A failure never occupies a (case, rep) slot in results.jsonl.
  const jsonl = (subset: readonly TrialRow[]): string =>
    subset.map((row) => JSON.stringify(row)).join('\n') + (subset.length > 0 ? '\n' : '');

  writeFileSync(join(dir, 'results.jsonl'), jsonl(rows.filter((r) => r.status === 'ok')));
  writeFileSync(join(dir, 'errors.jsonl'), jsonl(rows.filter((r) => r.status === 'failed')));
  writeFileSync(join(dir, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');

  return summary;
}

const pct = (value: number | null): string =>
  value === null ? '    —' : `${(value * 100).toFixed(0)}%`.padStart(5);

export function printSummary(summary: RunSummary): void {
  const failures = Object.entries(summary.failures).filter(([, n]) => n > 0);
  const seconds = (summary.duration_ms / 1000).toFixed(1);

  console.log(`\n\n${summary.decider_id} — split ${summary.split}, ${summary.reps} rep(s)`);
  console.log(`  ${summary.trials} trials, ${summary.scored} scored, ${seconds}s`);
  console.log(`  correct action        ${pct(summary.metrics.correct_action)}   (system)`);
  console.log(`  sound proposal        ${pct(summary.metrics.proposal_correct)}   (model alone)`);
  console.log(`  correct escalation    ${pct(summary.metrics.correct_escalation)}`);
  console.log(`  grounded evidence     ${pct(summary.metrics.grounded_evidence)}`);
  console.log(`  decisive facts cited  ${pct(summary.metrics.decisive_facts_cited)}`);
  console.log(`  citation precision    ${pct(summary.citation_precision)}`);
  console.log(`  escalation rate       ${pct(summary.escalation_rate)}`);
  console.log(`  majority baseline     ${pct(summary.majority_baseline)}`);
  console.log(`  reckless proposals    ${summary.wrongful_actions}   (model)`);
  console.log(`  unsafe acts EXECUTED  ${summary.unsafe_acts}   (system — gate blocks on any)`);
  if (failures.length > 0) {
    console.log(`  failures              ${failures.map(([k, n]) => `${k}=${n}`).join(', ')}`);
  }
}

function parseArgs(argv: readonly string[]): { options: RunOptions; smoke: boolean } {
  const value = (flag: string): string | undefined => {
    const index = argv.indexOf(flag);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  const policy = value('--policy');
  if (policy !== undefined && !SMOKE_POLICIES.includes(policy as SmokePolicy)) {
    throw new Error(`unknown policy "${policy}" — one of ${SMOKE_POLICIES.join(', ')}`);
  }

  return {
    smoke: argv.includes('--smoke'),
    options: {
      split: value('--split') ?? 'test',
      reps: Number(value('--reps') ?? '1'),
      outDir: value('--out') ?? 'evals/results',
      policy: (policy as SmokePolicy | undefined) ?? null,
    },
  };
}

const smokeFacts = (summary: RunSummary): SmokeFacts => ({
  trials: summary.trials,
  scored: summary.scored,
  malformed: summary.failures.malformed,
  premiseUnmet: summary.failures.premise_unmet,
  correctAction: summary.metrics.correct_action,
  escalationRate: summary.escalation_rate,
  majorityBaseline: summary.majority_baseline,
  unsafeActs: summary.unsafe_acts,
  distinctProposals: Object.values(summary.proposed_actions).filter((n) => n > 0).length,
});

/**
 * Runs the four policies and CHECKS them, rather than printing four tables for someone
 * to read. It is the harness testing itself, and it needs no model, so CI can run it on
 * every push for free and deterministically.
 */
async function runSmoke(options: RunOptions): Promise<boolean> {
  const verdicts: string[] = [];
  let allHeld = true;

  for (const policy of SMOKE_POLICIES) {
    const summary = await runEval({ ...options, policy });
    printSummary(summary);

    const expectation = SMOKE_EXPECTATIONS[policy];
    const held = expectation.holds(smokeFacts(summary));
    allHeld &&= held;
    verdicts.push(`  ${held ? 'PASS' : 'FAIL'}  ${policy.padEnd(16)} ${expectation.why}`);
  }

  console.log('\n\nsmoke expectations');
  for (const line of verdicts) console.log(line);
  console.log(allHeld ? '\nthe harness checks out\n' : '\nTHE HARNESS IS WRONG\n');
  return allHeld;
}

async function main(): Promise<void> {
  const { options, smoke } = parseArgs(process.argv.slice(2));

  if (smoke) {
    if (!(await runSmoke(options))) process.exitCode = 1;
    return;
  }

  printSummary(await runEval(options));
}

// Only when run as a script: importing this from a test must not start a run.
if (process.argv[1]?.includes('runner')) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
