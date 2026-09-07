import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { latestRun } from './gate';
import type { RunSummary, ScoredRow, TrialRow } from './grade';

/**
 * Turns a run into a page someone can argue with.
 *
 * The number that matters most here is not any of the scores: it is the noise floor. A
 * suite this size cannot resolve a small change, and a report that prints "78%" without
 * saying "give or take thirty points" invites a conversation about a two-point
 * improvement that is entirely made of sampling.
 */

/**
 * 95% confidence half-width for a proportion. Normal approximation; the suite is small.
 *
 * `n` is the number of distinct CASES, not the number of trials, and the difference is
 * not pedantry. Repetitions vary the model seed, and at temperature 0 that barely moves
 * a local model: measured on this suite, 21 of 24 cases produce the identical action in
 * all four reps. Four trials of the same case are therefore close to one observation
 * repeated, not four independent ones, and dividing by 96 instead of 24 would halve an
 * interval that did not actually shrink.
 *
 * What the repetitions DO vary is the ERP's die, which is real coverage — one trial only
 * reaches its `premise_unmet` state on rep 2 — and they would vary the model too against
 * a backend sampling above temperature 0. They are worth running. They are just not
 * worth counting as independent draws.
 */
function halfWidth(p: number | null, n: number): number | null {
  if (p === null || n === 0) return null;
  return 1.96 * Math.sqrt((p * (1 - p)) / n);
}

const pct = (value: number | null): string =>
  value === null ? '—' : `${(value * 100).toFixed(0)}%`;

function withInterval(value: number | null, n: number): string {
  const margin = halfWidth(value, n);
  return margin === null ? '—' : `${pct(value)} ± ${(margin * 100).toFixed(0)}`;
}

const readJsonl = <T>(path: string): T[] =>
  readFileSync(path, 'utf-8')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as T);

export function buildReport(summary: RunSummary, rows: readonly TrialRow[]): string {
  const scored = rows.filter((r): r is ScoredRow => r.status === 'ok');
  // Independent observations, which is cases — see `halfWidth`.
  const n = new Set(scored.map((row) => row.case_id)).size;
  const out: string[] = [];

  out.push(`# Eval run — ${summary.decider_id}`);
  out.push('');
  out.push(`- run: \`${summary.run_id}\``);
  out.push(`- split: \`${summary.split}\`, ${summary.cases} cases × ${summary.reps} rep(s)`);
  out.push(`- ${summary.trials} trials, ${n} scored, ${(summary.duration_ms / 1000).toFixed(1)}s`);
  out.push('');

  out.push('## Scores');
  out.push('');
  out.push('| metric | value | what it measures |');
  out.push('| --- | --- | --- |');
  out.push(
    `| correct action | ${withInterval(summary.metrics.correct_action, n)} | the system: model plus guardrails |`,
  );
  out.push(
    `| sound proposal | ${withInterval(summary.metrics.proposal_correct, n)} | the model alone, before the net |`,
  );
  out.push(
    `| correct escalation | ${withInterval(summary.metrics.correct_escalation, n)} | escalated exactly when it had to |`,
  );
  out.push(
    `| grounded evidence | ${withInterval(summary.metrics.grounded_evidence, n)} | every cited fact really exists |`,
  );
  out.push(
    `| decisive facts cited | ${withInterval(summary.metrics.decisive_facts_cited, n)} | cited what actually decides the case |`,
  );
  out.push(
    `| reckless proposals | ${summary.wrongful_actions} | the model wanted to act on a case that needed a person |`,
  );
  out.push(
    `| **unsafe acts executed** | **${summary.unsafe_acts}** | one is too many; the gate blocks on any |`,
  );
  out.push(
    `| citation precision | ${pct(summary.citation_precision)} | of what it cited, how much mattered |`,
  );
  out.push(`| escalation rate | ${pct(summary.escalation_rate)} | how often it handed the case over |`);
  out.push(
    `| proposed actions | ${Object.entries(summary.proposed_actions)
      .filter(([, n]) => n > 0)
      .map(([a, n]) => `${a} ${n}`)
      .join(', ')} | a shape, not a score: one action for everything means it did not read |`,
  );
  out.push(
    `| majority baseline | ${pct(summary.majority_baseline)} | what "escalate everything" would score |`,
  );
  out.push('');

  const margin = halfWidth(summary.metrics.correct_action, n);
  out.push('## Noise floor');
  out.push('');
  if (margin === null) {
    out.push('Nothing was scored, so there is no interval to state.');
  } else {
    out.push(
      `With ${scored.length} scored trials over ${n} distinct cases, the 95% interval on a ` +
        `score near this one is about ` +
        `**± ${(margin * 100).toFixed(0)} points** — computed over cases, because at temperature 0 ` +
        'the repetitions of one case are close to the same observation four times. ' +
        'That is the uncertainty about the NEXT 24 cases, and it is why nothing here should ' +
        'be read to two significant figures. It is not the same quantity as the gate ' +
        'tolerance, which asks a narrower question: would re-running this same commit ' +
        'produce a different number? Against a deterministic local backend, almost not at ' +
        'all. ' +
        'What the gate catches is the absolute rules — an unsafe act executed, an action ' +
        'resting on an invented citation, a run that scored nothing — where one occurrence is ' +
        'enough and no sample size is needed. Comparing two variants needs paired deltas over ' +
        'the same cases, which is what the prompt experiments in the history did.',
    );
  }
  out.push('');

  out.push('## By case');
  out.push('');
  out.push('| case | action | sound | escalated by | blocked by |');
  out.push('| --- | --- | --- | --- | --- |');
  for (const row of scored) {
    out.push(
      `| ${row.case_id}.${row.rep} | ${row.action} | ${row.metrics.proposal_correct ? 'yes' : 'no'} ` +
        `| ${row.escalated_by ?? '—'} | ${row.blocked_by.join(', ') || '—'} |`,
    );
  }
  out.push('');

  const failed = rows.filter((r) => r.status === 'failed');
  out.push('## Trials that produced no decision');
  out.push('');
  if (failed.length === 0) {
    out.push('None.');
  } else {
    out.push('These occupy no scored slot. They are counted, not averaged in.');
    out.push('');
    out.push('| case | class | message |');
    out.push('| --- | --- | --- |');
    for (const row of failed) {
      if (row.status !== 'failed') continue;
      out.push(`| ${row.case_id}.${row.rep} | ${row.failure_class} | ${row.message} |`);
    }
  }
  out.push('');

  return out.join('\n');
}

function main(): void {
  const argv = process.argv.slice(2);
  const index = argv.indexOf('--run');
  const runDir = index >= 0 ? argv[index + 1]! : latestRun('evals/results');

  const summary: RunSummary = JSON.parse(readFileSync(join(runDir, 'summary.json'), 'utf-8'));
  const rows = [
    ...readJsonl<TrialRow>(join(runDir, 'results.jsonl')),
    ...readJsonl<TrialRow>(join(runDir, 'errors.jsonl')),
  ];

  const path = join(runDir, 'report.md');
  writeFileSync(path, buildReport(summary, rows));
  console.log(path);
}

if (process.argv[1]?.includes('report')) main();
