/**
 * Measures how often the model produces a usable decision.
 *
 * This is not the eval suite — it has no golden labels, no gate and no report. It is the
 * smallest thing that answers one question: does a change to the prompt or the schema
 * make the model cite the facts it used, or not?
 *
 * It exists because the alternative was tuning the prompt by eye. Reps vary the model
 * seed, because at temperature 0 the same input gives the same output and repeating it
 * would measure nothing.
 *
 *   npx tsx scripts/measure-citations.ts [reps]
 */
import { buildTriageStack } from '../src/composition';
import { buildOllamaLlm } from '../src/adapters/secondary/ollama-llm';
import { seededDraw } from '../src/external-mocks/draw';
import { SGC_TAME } from '../src/external-mocks/erp-profile';
import { NULL_TRACER } from '../src/domain/trace';
import { MalformedDecisionError, TruncatedDecisionError } from '../src/ports/triage';
import type { Incident } from '../src/domain/incident';

const EVALUATED_AT = new Date('2026-08-30T15:00:00Z');

/** Six orders covering act, block and gap. The tame ERP, so the model is the only variable. */
const ORDERS = ['FC-10241', 'FC-10242', 'NC-10243', 'FC-10244', 'FC-10245', 'FC-10247'];

function incident(orderId: string): Incident {
  return {
    orderId,
    kind: 'damaged',
    customerMessage: 'Me llego la caja completamente mojada y el producto no enciende.',
    reportedAt: new Date('2026-08-30T14:02:00Z'),
    channel: 'email',
  };
}

interface Tally {
  runs: number;
  decided: number;
  cited: number;
  grounded: number;
  malformed: number;
  truncated: number;
  unavailable: number;
}

async function main(): Promise<void> {
  const reps = Number(process.argv[2] ?? '3');
  const t: Tally = {
    runs: 0,
    decided: 0,
    cited: 0,
    grounded: 0,
    malformed: 0,
    truncated: 0,
    unavailable: 0,
  };
  const startedAt = Date.now();

  for (let rep = 1; rep <= reps; rep++) {
    for (const orderId of ORDERS) {
      t.runs += 1;
      // A different model seed per rep: at temperature 0 the same seed gives the same
      // answer, so repeating it would just count the same run several times.
      const stack = buildTriageStack({
        profile: SGC_TAME,
        draw: seededDraw(7),
        llm: buildOllamaLlm({ seed: rep }),
      });

      try {
        const outcome = await stack.triage.run(incident(orderId), EVALUATED_AT, NULL_TRACER);
        t.decided += 1;
        if (outcome.proposal.evidence.length > 0) t.cited += 1;
        if (outcome.verdicts.some((v) => v.rule === 'evidence-grounded' && v.ok)) t.grounded += 1;
      } catch (error) {
        if (error instanceof MalformedDecisionError) t.malformed += 1;
        else if (error instanceof TruncatedDecisionError) t.truncated += 1;
        else t.unavailable += 1;
      }
      process.stdout.write('.');
    }
  }

  const pct = (n: number): string => `${((n / t.runs) * 100).toFixed(0)}%`.padStart(4);
  console.log(`\n\n${t.runs} runs in ${((Date.now() - startedAt) / 1000).toFixed(0)}s\n`);
  console.log(`  produced a decision   ${pct(t.decided)}  (${t.decided}/${t.runs})`);
  console.log(`  cited at least one    ${pct(t.cited)}  (${t.cited}/${t.runs})`);
  console.log(`  every citation real   ${pct(t.grounded)}  (${t.grounded}/${t.runs})`);
  console.log(`  malformed             ${pct(t.malformed)}  (${t.malformed}/${t.runs})`);
  console.log(`  truncated             ${pct(t.truncated)}  (${t.truncated}/${t.runs})`);
  console.log(`  backend unavailable   ${pct(t.unavailable)}  (${t.unavailable}/${t.runs})`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
