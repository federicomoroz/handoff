import { applyGuardrails } from '../domain/guardrails';
import type { Incident } from '../domain/incident';
import type { Outcome } from '../domain/decision';
import type { Tracer } from '../domain/trace';
import type { DecisionMakerPort, FactGathererPort, TriagePort } from '../ports/triage';

/**
 * The whole use case: gather, propose, verify.
 *
 * Note what this file does NOT import: no ERP, no model, no tool, no JSON schema, not a
 * line of HTTP. Two ports and the domain. That is the payoff of splitting triage into
 * two ports instead of one.
 *
 * The order is not negotiable either, and it is the project's thesis in three steps: the
 * facts come from the foreign system, the judgement comes from the model, and the last
 * word belongs to the code.
 */
export function buildTriageUseCase(deps: {
  readonly gatherer: FactGathererPort;
  readonly decider: DecisionMakerPort;
}): TriagePort {
  return {
    async run(incident: Incident, evaluatedAt: Date, tracer: Tracer): Promise<Outcome> {
      tracer.mark('input', incident.orderId, `${incident.kind} claim`);

      const facts = await deps.gatherer.gather(incident, evaluatedAt, tracer);
      const proposal = await deps.decider.propose(facts, tracer);
      const outcome = applyGuardrails(proposal, facts);

      tracer.mark(
        'output',
        outcome.kind,
        outcome.kind === 'acted'
          ? `${outcome.proposal.action}, nothing blocked`
          : `escalated by ${outcome.escalatedBy}${
              outcome.blockedBy.length > 0 ? `: ${outcome.blockedBy.join(', ')}` : ''
            }`,
      );

      return outcome;
    },
  };
}
