import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { RunSummary } from '../evals/grade';

/**
 * The README's numbers have to be the baseline's numbers.
 *
 * They were not. The prompt's line endings were normalised, the recording was redone
 * because the request hash had changed, and the new summary was copied over
 * `baseline.json` — but only `correct_action` was checked before saying "same numbers".
 * Four of the five had moved, one of them by twelve points, and the README carried the
 * old set into a commit that claimed otherwise.
 *
 * That is the third time in this project that a hand-copied number drifted from its
 * source: the prompt's thresholds drifted from the domain constants, the test count
 * drifted from the suite, and now this. All three had the same fix, which is this one —
 * the number is read from where it is produced, and a copy that stops matching fails a
 * test instead of being believed.
 *
 * The README rounds to whole percentages for a human reader, so the comparison rounds
 * too. It is not checking formatting; it is checking that nobody is quoting a run that
 * no longer exists.
 */

const BASELINE: RunSummary = JSON.parse(readFileSync('evals/baseline.json', 'utf-8'));
const README = readFileSync('README.md', 'utf-8');

/** Pulls `| label | **83%** |` out of the summary table, bold or not. */
function published(label: string): number {
  const row = new RegExp(`\\|\\s*\\*{0,2}${label}\\*{0,2}[^|]*\\|\\s*\\*{0,2}(\\d+)%`, 'i');
  const match = README.match(row);
  expect(match, `the README has no row for "${label}"`).not.toBeNull();
  return Number(match![1]);
}

describe('the numbers the README publishes', () => {
  it.each([
    ['correct action', 'correct_action'],
    ['sound proposal', 'proposal_correct'],
    ['correct escalation', 'correct_escalation'],
    ['grounded evidence', 'grounded_evidence'],
    ['decisive facts cited', 'decisive_facts_cited'],
  ] as const)('%s matches the recorded baseline', (label, key) => {
    const measured = BASELINE.metrics[key];
    expect(measured, `${key} is null in the baseline`).not.toBeNull();
    expect(published(label)).toBe(Math.round(measured! * 100));
  });

  it('reports the majority baseline the run actually had', () => {
    expect(published('majority baseline')).toBe(Math.round(BASELINE.majority_baseline * 100));
  });

  it('counts the reckless proposals and the trials they came from', () => {
    // The one number that must never be quoted loosely: it is the gap between what the
    // model wanted and what the net allowed, and it is the project's whole argument.
    expect(README).toContain(`${BASELINE.wrongful_actions} of ${BASELINE.trials}`);
  });

  it('claims zero unsafe acts only while there were zero', () => {
    expect(BASELINE.unsafe_acts).toBe(0);
    expect(README).toMatch(/\*\*unsafe acts executed\*\*\s*\|\s*\*\*0\*\*/);
  });
});
