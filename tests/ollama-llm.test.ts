import { describe, expect, it } from 'vitest';
import { buildOllamaLlm } from '../src/adapters/secondary/ollama-llm';
import { LlmUnavailableError, type LlmRequest } from '../src/ports/llm';
import type { Transport } from '../src/core/transport';

/**
 * The Ollama adapter is tested WITHOUT Ollama: the transport is injectable, so the shape
 * translation is verified against fixed responses. The whole suite runs with no network,
 * no GPU and no model downloaded.
 */

const REQUEST: LlmRequest = {
  system: 'you are a triage agent',
  messages: [{ role: 'user', content: 'order FC-10241 arrived broken' }],
  tools: [
    {
      name: 'record_decision',
      description: 'records the decision',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    },
  ],
  maxTokens: 256,
};

/** Always returns the same body and records what it was sent. */
function fakeTransport(body: unknown, status = 200) {
  const sent: unknown[] = [];
  const transport: Transport = async (req) => {
    sent.push(JSON.parse(await req.text()));
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });
  };
  return { transport, sent };
}

describe('translating the Ollama response', () => {
  it('normalises tool calls, usage and served model', async () => {
    const { transport } = fakeTransport({
      model: 'qwen3:4b',
      message: {
        content: '',
        tool_calls: [{ function: { name: 'record_decision', arguments: { action: 'escalate' } } }],
      },
      done_reason: 'stop',
      prompt_eval_count: 331,
      eval_count: 42,
    });

    const response = await buildOllamaLlm({ transport }).complete(REQUEST);

    expect(response.model).toBe('ollama:qwen3:4b');
    expect(response.stopReason).toBe('tool_use');
    expect(response.usage).toEqual({ inputTokens: 331, outputTokens: 42 });
    expect(response.toolCalls).toHaveLength(1);
    expect(response.toolCalls[0]!.name).toBe('record_decision');
    expect(response.toolCalls[0]!.input).toEqual({ action: 'escalate' });
    // Ollama does not number tool calls. The id comes from position (turn 1, index 0),
    // not from a shared counter: the same case yields the same id whether it runs alone
    // or in the middle of a 36-case suite.
    expect(response.toolCalls[0]!.id).toBe('call-1-0');
  });

  it('accepts arguments that arrive as a JSON string', async () => {
    const { transport } = fakeTransport({
      model: 'qwen3:4b',
      message: {
        content: '',
        tool_calls: [{ function: { name: 'record_decision', arguments: '{"action":"reship"}' } }],
      },
      done_reason: 'stop',
    });

    const response = await buildOllamaLlm({ transport }).complete(REQUEST);
    expect(response.toolCalls[0]!.input).toEqual({ action: 'reship' });
  });

  it('flags max_tokens when the answer was cut off with no tool call', async () => {
    // This is the real qwen3 case with reasoning on: it spends the budget thinking.
    const { transport } = fakeTransport({
      model: 'qwen3:4b',
      message: { content: '', tool_calls: [] },
      done_reason: 'length',
      prompt_eval_count: 289,
      eval_count: 512,
    });

    const response = await buildOllamaLlm({ transport }).complete(REQUEST);

    // Cut off is not wrong: the eval marks it truncated instead of averaging it as an error.
    expect(response.stopReason).toBe('max_tokens');
    expect(response.toolCalls).toEqual([]);
  });
});

describe('what gets sent to Ollama', () => {
  it('pins temperature 0 and a seed, so runs are reproducible', async () => {
    const { transport, sent } = fakeTransport({ model: 'qwen3:4b', message: { content: 'ok' } });

    await buildOllamaLlm({ transport, seed: 42 }).complete(REQUEST);

    const payload = sent[0] as { options: { temperature: number; seed: number }; stream: boolean };
    expect(payload.options.temperature).toBe(0);
    expect(payload.options.seed).toBe(42);
    expect(payload.stream).toBe(false);
  });

  it('retries without `think` when the model does not support reasoning', async () => {
    const sent: unknown[] = [];
    let call = 0;
    const transport: Transport = async (req) => {
      sent.push(JSON.parse(await req.text()));
      call += 1;
      // First call: Ollama rejects the parameter. Second: it goes through.
      return call === 1
        ? new Response('model does not support thinking', { status: 400 })
        : new Response(JSON.stringify({ model: 'qwen2.5:7b', message: { content: 'ok' } }), {
            status: 200,
          });
    };

    const response = await buildOllamaLlm({ transport, model: 'qwen2.5:7b' }).complete(REQUEST);

    expect(response.model).toBe('ollama:qwen2.5:7b');
    expect(sent).toHaveLength(2);
    expect(sent[0]).toHaveProperty('think');
    expect(sent[1]).not.toHaveProperty('think');
  });

  it('an error unrelated to thinking propagates without a retry', async () => {
    const { transport, sent } = fakeTransport({ error: 'model not found' }, 404);

    await expect(buildOllamaLlm({ transport }).complete(REQUEST)).rejects.toThrow(
      LlmUnavailableError,
    );
    expect(sent).toHaveLength(1);
  });
});

describe('truncation with a tool call present (regression)', () => {
  it('reports max_tokens even when a clipped tool call came back', async () => {
    // The dangerous shape: the model ran out of budget halfway through emitting the
    // call. Reporting `tool_use` here would send a cut answer down the validation path
    // and score it as bad judgement instead of counting it as truncated.
    const { transport } = fakeTransport({
      model: 'qwen2.5:3b',
      message: {
        content: '',
        tool_calls: [{ function: { name: 'record_decision', arguments: '{"action":"ref' } }],
      },
      done_reason: 'length',
      eval_count: 2000,
    });

    const response = await buildOllamaLlm({ transport }).complete(REQUEST);
    expect(response.stopReason).toBe('max_tokens');
  });

  it('a 200 whose body is not JSON is infrastructure, not a model failure', async () => {
    const transport: Transport = async () =>
      new Response('<html>502 from the proxy</html>', { status: 200 });

    await expect(buildOllamaLlm({ transport }).complete(REQUEST)).rejects.toThrow(
      LlmUnavailableError,
    );
  });
});
