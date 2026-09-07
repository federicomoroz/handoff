import type { Cents } from './money';
import type { CaseFacts } from './facts';

/** The four possible triage outcomes. */
export type Action = 'reship' | 'refund' | 'request_evidence' | 'escalate';

export const isActing = (action: Action): boolean => action !== 'escalate';

/**
 * What the model proposed, exactly as it came out of the tool. It has not been through
 * the guardrails yet, and it is kept whole: the wrongful-action metric is measured on
 * the proposal, not on what finally executed. A model the guardrails stopped every time
 * is not a safe model, it is a dangerous one with a net.
 */
export interface Proposal {
  readonly action: Action;
  /** Fraction from 0 to 1. The model sends an integer 0-100, converted at the edge. */
  readonly confidence: number;
  readonly amountCents: Cents | null;
  readonly reason: string;
  /**
   * The fact paths the model used, and nothing else. It does not restate the values:
   * looking a value up from its path has one correct answer, so the code does it — and
   * a model that never quotes a value can never misquote one.
   */
  readonly evidence: readonly string[];
  readonly missingFacts: readonly string[];
}

export type GuardrailVerdict =
  | { readonly ok: true; readonly rule: string }
  | { readonly ok: false; readonly rule: string; readonly reason: string };

/**
 * The result of the triage. `verdicts` ALWAYS carries every verdict, not just the first
 * one that blocked: stopping early gives the same decision but loses the diagnosis, and
 * the report has to be able to name the three rules that fired.
 *
 * `facts` is what the agent actually read before deciding, carried out with the result.
 * Without it a trajectory records the verdict and not the evidence, and nobody reviewing
 * a bad decision later can tell an agent that reasoned badly from one that was handed a
 * hole — which is the distinction this whole project is built around.
 *
 * `escalatedBy` says who decided: `model` when the model itself chose to delegate,
 * `guardrail` when it was stopped. The difference matters for measuring the model
 * instead of measuring the net that contains it — a model the net stops all the time is
 * not a safe model.
 */
export type Outcome =
  | {
      readonly kind: 'acted';
      readonly proposal: Proposal;
      readonly facts: CaseFacts;
      readonly verdicts: readonly GuardrailVerdict[];
    }
  | {
      readonly kind: 'escalated';
      readonly proposal: Proposal;
      readonly facts: CaseFacts;
      readonly verdicts: readonly GuardrailVerdict[];
      readonly escalatedBy: 'model' | 'guardrail';
      /** Every rule that failed. Reported even when the model had already escalated. */
      readonly blockedBy: readonly string[];
    };
