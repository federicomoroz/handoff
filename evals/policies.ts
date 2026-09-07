import { cents } from '../src/domain/money';
import { presentFactPaths, type CaseFacts } from '../src/domain/facts';
import type { Action, Proposal } from '../src/domain/decision';
import { MalformedDecisionError, type DecisionMakerPort } from '../src/ports/triage';
import type { EvalLabel } from './case';

/**
 * Four deciders with no model in them.
 *
 * They exist to test the harness rather than the agent, and each one is supposed to
 * produce a specific, known-in-advance result. If it does not, the number the suite
 * reports about a real model cannot be trusted either — which is the whole point: a
 * scoreboard nobody has tried to break is a scoreboard nobody should believe.
 *
 *   oracle           ~100% everywhere. Anything less is a broken grader, or a label
 *                    that cites a fact its own case does not have.
 *   null             zero scorable rows and N classified failures — NOT a score of 0%.
 *                    "Did not answer" and "answered wrongly" are different events, and
 *                    a suite that averages them together reports a number that means
 *                    nothing. This policy is the proof the runner keeps them apart.
 *   majority         always escalates. Fixes the baseline any real model has to beat,
 *                    and has to fail the act-side cases: a suite where "escalate
 *                    everything" scores well is measuring caution, not judgement.
 *   constant-refund  always refunds. Has to trip the wrongful-action metric and turn
 *                    the gate red. A gate that has never been seen going red is a
 *                    decoration.
 *
 * They are `DecisionMakerPort`, so they enter through the same seam a real model does
 * and every other layer stays exactly as it runs in production: the ERP is read for
 * real, the facts are gathered for real, the guardrails run for real.
 */

/**
 * Citations that exist, so `evidenceGrounded` measures what these policies do rather
 * than blocking all four of them at the door for the same reason.
 */
function realCitations(facts: CaseFacts, wanted: readonly string[] = []): string[] {
  const present = presentFactPaths(facts);
  const cited = wanted.filter((path) => present.has(path));
  if (cited.length > 0) return cited;
  const fallback = [...present][0];
  return fallback ? [fallback] : [];
}

function proposal(overrides: Partial<Proposal> & { action: Action }): Proposal {
  return {
    confidence: 0.99,
    amountCents: null,
    reason: 'issued by a smoke policy, with no model involved',
    evidence: [],
    missingFacts: [],
    ...overrides,
  };
}

/**
 * Answers what the label says, and cites the facts the label calls decisive.
 *
 * It reads the label because it IS the ground truth — that is what an oracle is. It
 * lives here in `evals/` for the same reason: nothing under `src/` may import this
 * directory, so there is no path from the agent to a file that knows the answers, and
 * the architecture test fails on the commit that creates one.
 */
export function oraclePolicy(label: EvalLabel): DecisionMakerPort {
  return {
    id: 'policy:oracle',
    propose(facts: CaseFacts): Promise<Proposal> {
      const action = label.acceptable_actions[0]!;
      // A refund needs an amount, and the only defensible one is the whole order.
      const amountCents = action === 'refund' && facts.order ? facts.order.total : null;

      return Promise.resolve(
        proposal({
          action,
          amountCents,
          reason: label.rationale,
          evidence: realCitations(facts, label.decisive_facts),
        }),
      );
    },
  };
}

/** Never answers. The failure it raises is a model failure, and never a judgement. */
export function nullPolicy(): DecisionMakerPort {
  return {
    id: 'policy:null',
    propose(): Promise<Proposal> {
      return Promise.reject(
        new MalformedDecisionError('policy:null', ['no decision was produced'], ''),
      );
    },
  };
}

/** Always escalates. The bar a real model has to clear to be worth anything. */
export function majorityPolicy(): DecisionMakerPort {
  return {
    id: 'policy:majority',
    propose(facts: CaseFacts): Promise<Proposal> {
      return Promise.resolve(
        proposal({
          action: 'escalate',
          reason: 'this policy escalates everything, which is exactly why it is a baseline',
          evidence: realCitations(facts),
        }),
      );
    },
  };
}

/** Always refunds the full order. The regression the gate exists to catch. */
export function constantRefundPolicy(): DecisionMakerPort {
  return {
    id: 'policy:constant-refund',
    propose(facts: CaseFacts): Promise<Proposal> {
      return Promise.resolve(
        proposal({
          action: 'refund',
          amountCents: facts.order ? facts.order.total : cents(0),
          reason: 'this policy refunds everything, which is what a broken agent looks like',
          evidence: realCitations(facts),
        }),
      );
    },
  };
}

export const SMOKE_POLICIES = ['oracle', 'null', 'majority', 'constant-refund'] as const;
export type SmokePolicy = (typeof SMOKE_POLICIES)[number];

/** Builds one policy. The oracle is the only one that needs the label. */
export function buildPolicy(name: SmokePolicy, label: EvalLabel): DecisionMakerPort {
  switch (name) {
    case 'oracle':
      return oraclePolicy(label);
    case 'null':
      return nullPolicy();
    case 'majority':
      return majorityPolicy();
    case 'constant-refund':
      return constantRefundPolicy();
  }
}
