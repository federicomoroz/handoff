import { appTransport, type Transport } from './core/transport';
import { buildMocksApp } from './external-mocks/erp-mocks';
import { SGC_HOSTILE, type ErpProfile } from './external-mocks/erp-profile';
import { BASE_SEED, type ErpSeed } from './external-mocks/erp-seed';
import { systemDraw, type Draw } from './external-mocks/draw';
import { SgcSession } from './adapters/secondary/sgc-session';
import { buildSgcErpAdapter } from './adapters/secondary/sgc-erp-adapter';
import { buildErpFactGatherer } from './adapters/secondary/erp-fact-gatherer';
import { buildOllamaLlm } from './adapters/secondary/ollama-llm';
import { buildLlmDecisionMaker } from './adapters/secondary/llm-decision-maker';
import { buildTriageUseCase } from './use-cases/triage-incident';
import type { LlmPort } from './ports/llm';
import type { DecisionMakerPort, TriagePort } from './ports/triage';

/**
 * The single place where the agent is assembled.
 *
 * It is the shortest file that matters most in the repo, and it exists for a concrete
 * reason: the HTTP server and the eval runner both call HERE, rather than each wiring
 * things its own way. If they diverged, the eval would measure one thing and production
 * would run another, and the number in the README would mean nothing. An AST test
 * verifies the runner does not build the stack on its own.
 *
 * Everything substitutable comes in as a parameter with a sane default:
 *
 *   - `decider`      — the eval's four smoke policies enter here, with no model at all
 *   - `llm`          — Ollama, Anthropic, or the replay cassettes
 *   - `profile`      — the hostile ERP or the tame one
 *   - `draw`         — the ERP's randomness, with a fixed seed in tests and evals
 *   - `erpTransport` — the simulated ERP today, a real one the day it exists
 */

export interface TriageStack {
  readonly triage: TriagePort;
  /** Who decided, so the eval report can record it on every row. */
  readonly deciderId: string;
  /**
   * Which ERP this stack talks to.
   *
   * It is reported rather than assumed: leaving `erpTransport` out builds the simulator,
   * which is the right default for a demo about that ERP but the wrong thing to discover
   * later. Every caller can print it, and every eval row can record it.
   */
  readonly erp: 'simulated' | 'external';
}

export interface StackOptions {
  readonly profile?: ErpProfile;
  readonly seed?: ErpSeed;
  readonly draw?: Draw;
  /**
   * Points at a real ERP. When given, the simulator is not built.
   *
   * Leaving it out builds the simulated SGC, which is the right default for a demo whose
   * whole subject is that ERP — but it is worth saying plainly: a caller that forgets
   * this gets fiction, served without complaint.
   */
  readonly erpTransport?: Transport;
  readonly llm?: LlmPort;
  /** Replaces the judgement entirely. This is how the oracle and null policies get in. */
  readonly decider?: DecisionMakerPort;
}

export function buildTriageStack({
  profile = SGC_HOSTILE,
  seed = BASE_SEED,
  draw = systemDraw,
  erpTransport,
  llm,
  decider,
}: StackOptions = {}): TriageStack {
  // No third branch: either a transport was handed in, or the simulator is built. The
  // previous fallback to `networkTransport` was unreachable — it could only be chosen by
  // a caller who had already supplied a transport.
  const transport = erpTransport ?? appTransport(buildMocksApp({ profile, seed, draw }));

  const erp = buildSgcErpAdapter(new SgcSession(transport));
  const gatherer = buildErpFactGatherer(erp);
  const resolvedDecider = decider ?? buildLlmDecisionMaker(llm ?? buildOllamaLlm());

  return {
    triage: buildTriageUseCase({ gatherer, decider: resolvedDecider }),
    deciderId: resolvedDecider.id,
    erp: erpTransport ? 'external' : 'simulated',
  };
}
