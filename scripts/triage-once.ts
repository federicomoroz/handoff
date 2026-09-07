/**
 * Runs ONE case end to end, against the real model.
 *
 * It is the same circuit the eval runner will drive: hostile ERP -> session -> adapter
 * -> gatherer -> model -> guardrails. Assembled by `buildTriageStack`, the same one the
 * server uses.
 *
 *   npx tsx scripts/triage-once.ts FC-10241
 */
import { buildTriageStack } from '../src/composition';
import { seededDraw } from '../src/external-mocks/draw';
import { TraceRecorder } from '../src/domain/trace';
import { formatArs } from '../src/domain/money';
import type { Incident } from '../src/domain/incident';
import { MalformedDecisionError, TruncatedDecisionError } from '../src/ports/triage';

const EVALUATED_AT = new Date('2026-08-30T15:00:00Z');

async function main(): Promise<void> {
  const orderId = process.argv[2] ?? 'FC-10241';

  const incident: Incident = {
    orderId,
    kind: 'damaged',
    // Customer text stays in Spanish: it is data from a simulated Argentine operation.
    customerMessage: 'Me llego la caja completamente mojada y el producto no enciende.',
    reportedAt: new Date('2026-08-30T14:02:00Z'),
    channel: 'email',
  };

  // Fixed seed: the ERP misbehaves the same way every run.
  const stack = buildTriageStack({ draw: seededDraw(7) });
  const tracer = new TraceRecorder();
  const startedAt = Date.now();

  console.log(`erp     : ${stack.erp}`);
  console.log(`decider : ${stack.deciderId}`);
  console.log(`order   : ${orderId}\n`);

  const outcome = await stack.triage.run(incident, EVALUATED_AT, tracer);
  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);

  const proposal = outcome.proposal;
  console.log(`proposed: ${proposal.action} (confidence ${proposal.confidence.toFixed(2)})`);
  if (proposal.amountCents !== null) console.log(`amount  : ${formatArs(proposal.amountCents)}`);
  console.log(`reason  : ${proposal.reason}`);
  console.log(`cited   : ${proposal.evidence.join(', ') || '(nothing)'}`);
  if (proposal.missingFacts.length > 0) {
    console.log(`missing : ${proposal.missingFacts.join(', ')}`);
  }

  console.log(`\nresolved: ${outcome.kind}`);
  if (outcome.kind === 'escalated') {
    console.log(`escalated by: ${outcome.escalatedBy}`);
    if (outcome.blockedBy.length > 0) console.log(`blocked by  : ${outcome.blockedBy.join(', ')}`);
  }

  console.log(`\nelapsed : ${elapsed}s`);
  console.log('\ntrace:');
  for (const entry of tracer.entries) {
    console.log(
      `  ${String(entry.elapsedMs).padStart(8)}ms  ${entry.step.padEnd(10)} ${entry.label} — ${entry.detail}`,
    );
  }
}

main().catch((error: unknown) => {
  console.error(`\nFAILED: ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`);
  if (error instanceof TruncatedDecisionError) console.error(`\nit wrote:\n${error.preview}`);
  if (error instanceof MalformedDecisionError) console.error(`\nit returned:\n${error.raw}`);
  process.exitCode = 1;
});
