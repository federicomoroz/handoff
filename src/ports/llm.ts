/**
 * The model port.
 *
 * It does the most work of the three, because it has four real implementations and all
 * of them are used:
 *
 *   - `OllamaLlm`     — a local model: free and reproducible (fixed seed, temperature 0)
 *   - `AnthropicLlm`  — Claude, for when there is credit
 *   - `ReplayLlm`     — recorded responses, so CI runs in zero seconds and zero money
 *   - the four smoke policies — oracle, null, majority and constant-refund
 *
 * The eval suite *is* this port, substituted. Without the port there are no evals, and
 * that is the proof it is not decoration.
 *
 * The normalised shape below is what justifies it: Anthropic returns `tool_use` blocks
 * and Ollama returns OpenAI-style `tool_calls`. Translating both into one `LlmToolCall`
 * is exactly an adapter's job — and also the real job of a forward deployed engineer
 * when a customer switches providers mid-project.
 */

export interface LlmToolSpec {
  readonly name: string;
  readonly description: string;
  /** JSON Schema for the input. Generated from Zod so it is never written twice. */
  readonly inputSchema: Record<string, unknown>;
}

export interface LlmToolCall {
  readonly id: string;
  readonly name: string;
  /** Already parsed. No string matching is ever done on the serialised input. */
  readonly input: unknown;
}

/**
 * Only user messages, because that is all this system sends.
 *
 * The assistant and tool-result variants a multi-turn loop would need are deliberately
 * absent: the design gathers facts in code and asks the model once. They go in when an
 * agentic gatherer exists to need them, not before — untested branches built for a
 * future shape are how a port stops describing the system it has.
 */
export type LlmMessage = { readonly role: 'user'; readonly content: string };

export interface LlmRequest {
  readonly system: string;
  readonly messages: readonly LlmMessage[];
  readonly tools: readonly LlmToolSpec[];
  readonly maxTokens: number;
}

export interface LlmUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
}

/**
 * `stopReason` matters as much as the content: `max_tokens` means the answer was cut
 * off, and a cut-off answer is not a wrong answer. The eval marks it `truncated` and
 * keeps it out of the average instead of counting it as a model error.
 */
export type LlmStopReason = 'tool_use' | 'end_turn' | 'max_tokens' | 'other';

export interface LlmResponse {
  /** The model that actually served, read from the response and asserted against the ask. */
  readonly model: string;
  readonly text: string;
  readonly toolCalls: readonly LlmToolCall[];
  readonly stopReason: LlmStopReason;
  readonly usage: LlmUsage;
}

export class LlmUnavailableError extends Error {
  constructor(
    readonly backend: string,
    message: string,
  ) {
    super(`${backend}: ${message}`);
    this.name = 'LlmUnavailableError';
  }
}

export interface LlmPort {
  /** Identifies backend and model: `ollama:qwen3:4b`, `anthropic:claude-opus-5`. */
  readonly id: string;
  complete(request: LlmRequest): Promise<LlmResponse>;
}
