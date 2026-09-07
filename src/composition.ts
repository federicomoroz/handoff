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
  /**
   * The seed of the DEFAULT backend, for callers that want to vary the model without
   * knowing which model it is.
   *
   * The eval needs this: at temperature 0 the same seed returns the same answer, so
   * repetitions that do not vary it count one run several times and report a confidence
   * interval of zero. Passing it here rather than letting the runner build its own
   * backend is what keeps the eval on the production assembly — the runner says "vary
   * the seed", and this file stays the only place that decides what the backend is.
   */
  readonly llmSeed?: number;
  /**
   * Decorates whatever backend this file chose, without the caller naming it.
   *
   * The eval needs to wrap the model in a recorder or replace it with a cassette, and it
   * must do that WITHOUT importing an adapter — otherwise the runner starts assembling
   * the agent, which is the one thing it is not allowed to do. So it hands in a wrapper
   * and this file decides what gets wrapped. The seam stays here; the decoration is the
   * caller's.
   */
  readonly wrapLlm?: (llm: LlmPort) => LlmPort;
  /** Replaces the judgement entirely. This is how the oracle and null policies get in. */
  readonly decider?: DecisionMakerPort;
}

export function buildTriageStack({
  profile = SGC_HOSTILE,
  seed = BASE_SEED,
  draw = systemDraw,
  erpTransport,
  llm,
  llmSeed,
  wrapLlm,
  decider,
}: StackOptions = {}): TriageStack {
  // Silently ignoring one of the two would let an eval believe it varied the model
  // across repetitions while every run used the same seed.
  if (llm && llmSeed !== undefined) {
    throw new Error('llmSeed only applies to the default backend; a supplied llm carries its own');
  }
  // No third branch: either a transport was handed in, or the simulator is built. The
  // previous fallback to `networkTransport` was unreachable — it could only be chosen by
  // a caller who had already supplied a transport.
  const transport = erpTransport ?? appTransport(buildMocksApp({ profile, seed, draw }));

  const erp = buildSgcErpAdapter(new SgcSession(transport));
  const gatherer = buildErpFactGatherer(erp);
  const backend = llm ?? buildOllamaLlm(llmSeed === undefined ? {} : { seed: llmSeed });
  const resolvedDecider = decider ?? buildLlmDecisionMaker(wrapLlm ? wrapLlm(backend) : backend);

  return {
    triage: buildTriageUseCase({ gatherer, decider: resolvedDecider }),
    deciderId: resolvedDecider.id,
    erp: erpTransport ? 'external' : 'simulated',
  };
}
