import { mkdtempSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { CassetteMissingError, cassetteKey, recordingLlm, replayLlm } from '../evals/cassette-llm';
import type { LlmPort, LlmRequest, LlmResponse } from '../src/ports/llm';

/**
 * The cassettes, tested on the property that makes them honest rather than a stub.
 *
 * A stub answers the same thing however the prompt changes. These refuse to answer at
 * all: the key is a hash of the entire request, so anything that can move the model's
 * answer moves the key, the recording goes missing and the run fails asking to be
 * re-recorded. Everything below is one half of that bargain — the key must change when
 * the request changes, and must NOT change when nothing did.
 */

const REQUEST: LlmRequest = {
  system: 'you are the triage agent',
  messages: [{ role: 'user', content: '## Incident\n- order: FC-10241' }],
  tools: [{ name: 'record_decision', description: 'decide', inputSchema: { type: 'object' } }],
  maxTokens: 2000,
};

const RESPONSE: LlmResponse = {
  model: 'qwen2.5:3b',
  text: '',
  toolCalls: [{ id: 'call-0-0', name: 'record_decision', input: { action: 'refund' } }],
  stopReason: 'tool_use',
  usage: { inputTokens: 900, outputTokens: 60 },
};

function fakeLlm(id = 'ollama:qwen2.5:3b'): LlmPort & { calls: number } {
  return {
    id,
    calls: 0,
    complete(): Promise<LlmResponse> {
      this.calls += 1;
      return Promise.resolve(RESPONSE);
    },
  };
}

const scratch = (): string => mkdtempSync(join(tmpdir(), 'handoff-cassette-'));

describe('the cassette key', () => {
  it.each([
    ['the system prompt', { system: 'a different prompt' }],
    ['the rendered facts', { messages: [{ role: 'user' as const, content: 'other facts' }] }],
    ['the tool schema', { tools: [{ ...REQUEST.tools[0]!, inputSchema: { type: 'string' } }] }],
    ['the token ceiling', { maxTokens: 1000 }],
  ])('changes when %s changes', (_what, patch) => {
    // Each of these can change what the model answers, so each has to invalidate the
    // recording. This is the entire reason CI is allowed to trust a replayed number.
    const before = cassetteKey('ollama:qwen2.5:3b', '1', REQUEST);
    const after = cassetteKey('ollama:qwen2.5:3b', '1', { ...REQUEST, ...patch });

    expect(after).not.toBe(before);
  });

  it('changes when the model or the seed changes', () => {
    const base = cassetteKey('ollama:qwen2.5:3b', '1', REQUEST);

    expect(cassetteKey('anthropic:claude-opus-5', '1', REQUEST)).not.toBe(base);
    // The seed lives in the backend rather than in the request. Without it in the key,
    // four repetitions would share one recording and a four-rep run would silently
    // become the same answer four times.
    expect(cassetteKey('ollama:qwen2.5:3b', '2', REQUEST)).not.toBe(base);
  });

  it('does not change when only key order does', () => {
    // A key that moved when nothing moved would send CI red on a refactor, which is
    // exactly the noise this is supposed not to produce.
    const reordered: LlmRequest = {
      maxTokens: REQUEST.maxTokens,
      tools: REQUEST.tools,
      messages: REQUEST.messages,
      system: REQUEST.system,
    };

    expect(cassetteKey('ollama:qwen2.5:3b', '1', reordered)).toBe(
      cassetteKey('ollama:qwen2.5:3b', '1', REQUEST),
    );
  });
});

describe('recording and replaying', () => {
  it('replays exactly what was recorded, without calling the backend', async () => {
    const dir = scratch();
    const inner = fakeLlm();

    const recorded = await recordingLlm(inner, { dir, variant: '1' }).complete(REQUEST);
    const replayed = await replayLlm(inner.id, { dir, variant: '1' }).complete(REQUEST);

    expect(replayed).toEqual(recorded);
    expect(readdirSync(dir)).toHaveLength(1);
    expect(inner.calls, 'the replay must not reach the backend').toBe(1);
  });

  it('refuses when the request changed, instead of answering something else', async () => {
    const dir = scratch();
    await recordingLlm(fakeLlm(), { dir, variant: '1' }).complete(REQUEST);

    const changed = { ...REQUEST, system: 'a prompt nobody recorded' };
    await expect(replayLlm('ollama:qwen2.5:3b', { dir, variant: '1' }).complete(changed)).rejects
      .toBeInstanceOf(CassetteMissingError);
  });

  it('refuses a recording made by a different model', async () => {
    // Requirement 9 of the eval design. Replaying one model's answers under another
    // model's name puts a number under the wrong heading, and nobody notices until the
    // comparison is already published.
    const dir = scratch();
    await recordingLlm(fakeLlm('ollama:qwen2.5:3b'), { dir, variant: '1' }).complete(REQUEST);

    // Same key, different claimed identity: reachable when a cassette directory is
    // copied between backends rather than re-recorded.
    const wrongName = replayLlm('anthropic:claude-opus-5', { dir, variant: '1' });
    await expect(wrongName.complete(REQUEST)).rejects.toThrow(/no cassette/);
  });

  it('keeps repetitions apart on disk', async () => {
    const dir = scratch();
    const inner = fakeLlm();

    await recordingLlm(inner, { dir, variant: '1' }).complete(REQUEST);
    await recordingLlm(inner, { dir, variant: '2' }).complete(REQUEST);

    expect(readdirSync(dir)).toHaveLength(2);
  });
});
