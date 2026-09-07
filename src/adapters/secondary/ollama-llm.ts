import { networkTransport, type Transport } from '../../core/transport';
import {
  LlmUnavailableError,
  type LlmPort,
  type LlmRequest,
  type LlmResponse,
  type LlmStopReason,
  type LlmToolCall,
} from '../../ports/llm';

/**
 * Local backend, through Ollama.
 *
 * It is the project's default for a blunt reason: it is free, and a portfolio piece that
 * cannot be run is worth nothing. But it has two advantages of its own that are not
 * consolation prizes:
 *
 *   - It is reproducible. With `temperature: 0` and a fixed seed, the same input gives
 *     the same output. A cloud API does not offer that, and for an eval suite
 *     reproducibility is worth a lot.
 *   - It runs on-premise. That is the real constraint of a customer who cannot send data
 *     outside: banks, healthcare, public bodies. The same code serving both cases is
 *     what this port is demonstrating.
 *
 * What has to be said plainly: a small local model gets this task right less often than
 * Claude. That is a measurement, not a defect — it is what the suite is for, and it is
 * why the report publishes the majority-class baseline next to the score.
 */

export const OLLAMA_URL = process.env['OLLAMA_URL'] ?? 'http://127.0.0.1:11434';

/**
 * Chosen by measurement on a 4 GB GTX 1660 Ti, not by reputation:
 *
 *   qwen2.5:7b  116.3s  calls the tool, but does not fit in VRAM and spills to CPU
 *   qwen3:4b     10.6s  fits, but is a reasoning model: it burns the entire token
 *                       budget writing prose and never reaches the tool call, even
 *                       with `think: false`
 *   qwen2.5:3b    3.2s  fits, does not reason, calls the tool immediately
 *
 * Over a 36-case suite at 2 reps that is four minutes against four hours, so the choice
 * is not a preference — it is the reason the suite can be run at all.
 */
export const OLLAMA_MODEL = process.env['HANDOFF_MODEL'] ?? 'qwen2.5:3b';

/** Reasoning off by default; `HANDOFF_THINK=1` turns it on. See `think`. */
const OLLAMA_THINK = process.env['HANDOFF_THINK'] === '1';

/** Fixed so runs are reproducible. Changing it changes the experiment. */
const OLLAMA_SEED = 7;

/** A local model partly on CPU is slow; the ceiling matches that, it is not an oversight. */
const OLLAMA_TIMEOUT_MS = 180_000;

interface OllamaToolCall {
  readonly function?: { readonly name?: unknown; readonly arguments?: unknown };
}

interface OllamaChatResponse {
  readonly model?: unknown;
  readonly message?: {
    readonly content?: unknown;
    readonly tool_calls?: readonly OllamaToolCall[];
  };
  readonly done_reason?: unknown;
  readonly prompt_eval_count?: unknown;
  readonly eval_count?: unknown;
}

export interface OllamaOptions {
  readonly model?: string;
  readonly baseUrl?: string;
  readonly transport?: Transport;
  readonly seed?: number;
  /**
   * For reasoning models (qwen3, deepseek-r1). When `false` they do not think before
   * answering.
   *
   * Not an aesthetic preference: qwen3:4b with reasoning on spends the entire token
   * budget thinking and ends at `max_tokens` without ever calling a tool.
   */
  readonly think?: boolean;
}

export function buildOllamaLlm({
  model = OLLAMA_MODEL,
  baseUrl = OLLAMA_URL,
  transport = networkTransport,
  seed = OLLAMA_SEED,
  think = OLLAMA_THINK,
}: OllamaOptions = {}): LlmPort {
  const id = `ollama:${model}`;

  return {
    id,

    async complete(request: LlmRequest): Promise<LlmResponse> {
      const basePayload = {
        model,
        stream: false,
        messages: [
          { role: 'system', content: request.system },
          ...request.messages.map(toOllamaMessage),
        ],
        tools: request.tools.map((tool) => ({
          type: 'function',
          function: {
            name: tool.name,
            description: tool.description,
            parameters: tool.inputSchema,
          },
        })),
        options: { temperature: 0, seed, num_predict: request.maxTokens },
      };

      let response: Response;
      try {
        response = await send(transport, baseUrl, { ...basePayload, think }, id);
      } catch (error) {
        // A model that does not reason rejects the `think` parameter. Rather than keeping
        // a list of which model accepts it — which ages on its own — we try and retry
        // without it. Same principle as with SGC: adapt to the foreign system.
        if (!mentionsThinking(error)) throw error;
        response = await send(transport, baseUrl, basePayload, id);
      }

      let body: OllamaChatResponse;
      try {
        body = (await response.json()) as OllamaChatResponse;
      } catch (cause) {
        // A proxy answering 200 with an HTML error page is the common case. It is an
        // infrastructure failure, not a model one, and the port promises that shape.
        const detail = cause instanceof Error ? cause.message : String(cause);
        throw new LlmUnavailableError(id, `response body was not JSON (${detail})`);
      }

      const served = typeof body.model === 'string' ? body.model : model;
      const turn = request.messages.length;
      const rawCalls = Array.isArray(body.message?.tool_calls) ? body.message.tool_calls : [];
      const toolCalls = rawCalls.map((raw, index) => toDomainToolCall(raw, turn, index));

      return {
        model: `ollama:${served}`,
        text: typeof body.message?.content === 'string' ? body.message.content : '',
        toolCalls,
        stopReason: toStopReason(body.done_reason, toolCalls.length),
        usage: {
          inputTokens: countOf(body.prompt_eval_count),
          outputTokens: countOf(body.eval_count),
        },
      };
    },
  };
}

async function send(
  transport: Transport,
  baseUrl: string,
  payload: unknown,
  id: string,
): Promise<Response> {
  let response: Response;
  try {
    response = await transport(
      new Request(new URL('/api/chat', baseUrl), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(OLLAMA_TIMEOUT_MS),
      }),
    );
  } catch (cause) {
    const detail = cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause);
    throw new LlmUnavailableError(id, `could not reach Ollama (${detail})`);
  }

  if (!response.ok) {
    throw new LlmUnavailableError(id, `HTTP ${response.status}: ${await response.text()}`);
  }
  return response;
}

/**
 * Ollama does not give tool calls an id; Anthropic does. One is synthesised.
 *
 * The id comes from position: the conversation turn plus the index within the response.
 * No module-level counter — with shared state, the same case run first or thirtieth
 * would get different ids, and those ids end up in the trajectory and in the cassette
 * hash. An eval that is not reproducible measures nothing.
 */
function toDomainToolCall(raw: OllamaToolCall, turn: number, index: number): LlmToolCall {
  const args = raw.function?.arguments;
  return {
    id: `call-${turn}-${index}`,
    name: typeof raw.function?.name === 'string' ? raw.function.name : '',
    // Ollama sometimes sends the object already parsed and sometimes a JSON string.
    input: typeof args === 'string' ? safeParse(args) : (args ?? {}),
  };
}

const toOllamaMessage = (message: LlmRequest['messages'][number]) => ({
  role: message.role,
  content: message.content,
});

/**
 * Truncation outranks everything, including a tool call that is present.
 *
 * A model can run out of budget halfway through emitting the call: the block is there
 * but its arguments are cut. Reporting that as `tool_use` loses the only signal that
 * separates "the answer was clipped" from "the model judged badly" — which is the
 * distinction half the eval design rests on.
 */
function toStopReason(raw: unknown, toolCallCount: number): LlmStopReason {
  if (raw === 'length') return 'max_tokens';
  if (toolCallCount > 0) return 'tool_use';
  if (raw === 'stop') return 'end_turn';
  return 'other';
}

const countOf = (raw: unknown): number => (typeof raw === 'number' ? raw : 0);

/** Recognises Ollama's rejection when the model does not support reasoning. */
const mentionsThinking = (error: unknown): boolean =>
  error instanceof LlmUnavailableError && /think/i.test(error.message);

const safeParse = (raw: string): unknown => {
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
};
