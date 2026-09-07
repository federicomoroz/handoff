import type { CaseFacts } from '../../domain/facts';
import type { Proposal } from '../../domain/decision';
import type { Tracer } from '../../domain/trace';
import type { LlmPort } from '../../ports/llm';
import {
  MalformedDecisionError,
  TruncatedDecisionError,
  type DecisionMakerPort,
} from '../../ports/triage';
import { DECISION_TOOL, DECISION_TOOL_NAME, parseDecision } from './decision-tool';
import { loadSystemPrompt, renderFacts } from './triage-prompt';

/**
 * The component that asks the model for a judgement.
 *
 * One call, one tool. There is no agentic loop because there is nothing to route: by the
 * time this runs the facts are already read and clean.
 *
 * The three ways of ending badly are kept apart, and that distinction is the reason for
 * half of the eval design:
 *
 *   - `TruncatedDecisionError`  — the answer was cut off by the token budget. Not a wrong
 *                                 decision; the eval counts it separately.
 *   - `MalformedDecisionError`  — the model answered something that does not validate. A
 *                                 model failure with its own metric, but not a zero on
 *                                 judgement.
 *   - `LlmUnavailableError`     — we could not ask. Infrastructure; it never touches the score.
 */

/**
 * Measured, not chosen: qwen3:4b writes 700-900 tokens of plain-text reasoning BEFORE
 * calling the tool, even with `think: false` — which suppresses the thinking blocks but
 * not the urge to think. At 900 it ran out of budget right before deciding. The ceiling
 * has to cover the preamble plus the call, not just the call.
 */
const DECISION_MAX_TOKENS = 2_000;

/** How much of a failed answer is kept for diagnosis. One length, not two. */
const ERROR_PREVIEW_CHARS = 800;

export function buildLlmDecisionMaker(llm: LlmPort): DecisionMakerPort {
  return {
    id: `llm:${llm.id}`,

    async propose(facts: CaseFacts, tracer: Tracer): Promise<Proposal> {
      const response = await llm.complete({
        system: loadSystemPrompt(),
        messages: [{ role: 'user', content: renderFacts(facts) }],
        tools: [DECISION_TOOL],
        maxTokens: DECISION_MAX_TOKENS,
      });

      tracer.mark(
        'model',
        response.model,
        `${response.stopReason}, ${response.usage.inputTokens}+${response.usage.outputTokens} tokens`,
      );

      // Truncation is checked FIRST, before looking for the call. A run that hit the
      // budget can still carry a tool-call block with clipped arguments; validating it
      // would report a cut answer as a bad judgement.
      if (response.stopReason === 'max_tokens') {
        throw new TruncatedDecisionError(
          llm.id,
          response.usage.outputTokens,
          response.text.slice(0, ERROR_PREVIEW_CHARS),
        );
      }

      const call = response.toolCalls.find((c) => c.name === DECISION_TOOL_NAME);
      if (!call) {
        throw new MalformedDecisionError(
          llm.id,
          ['did not call the tool'],
          response.text.slice(0, ERROR_PREVIEW_CHARS),
        );
      }

      const parsed = parseDecision(call.input);
      if (!parsed.ok) {
        throw new MalformedDecisionError(llm.id, parsed.issues, JSON.stringify(call.input));
      }

      tracer.mark(
        'model',
        'proposal',
        `${parsed.proposal.action} with confidence ${parsed.proposal.confidence.toFixed(2)}`,
      );
      return parsed.proposal;
    },
  };
}
