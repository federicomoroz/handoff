import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { LlmPort, LlmRequest, LlmResponse } from '../src/ports/llm';

/**
 * Recorded model calls, so CI can measure the model without a GPU or an API bill.
 *
 * The part that makes this honest rather than a shortcut is the key. A cassette is named
 * by a hash of the ENTIRE request — model, seed, system prompt, the rendered facts, the
 * tool schema, the token ceiling. Change any of them and the hash changes, the cassette
 * is missing, and CI goes red asking for a re-record. So:
 *
 *   - a refactor that cannot affect the model replays for free, on every push;
 *   - a change to the prompt, the tools or the schema CANNOT be merged without
 *     re-recording, and re-recording is what updates the baseline.
 *
 * Which means the model is measured on every change that can affect it and nothing is
 * paid for the changes that cannot. That is the opposite of a stubbed test: a stub says
 * the same thing however the prompt changes, and this refuses to say anything at all.
 *
 * It rests on the prompt being byte-identical between recording and replay, which is a
 * property of the ERP simulation being deterministic — checked, not assumed: seven
 * consecutive runs of the same configuration produce the same facts for every trial.
 */

/** A cassette on disk. The request is kept whole so a stale one can be diffed, not guessed at. */
interface Cassette {
  readonly key: string;
  readonly llm_id: string;
  readonly variant: string;
  readonly recorded_at: string;
  readonly request: LlmRequest;
  readonly response: LlmResponse;
}

/**
 * The cassette is missing, which means the request changed.
 *
 * Its own class because it must not be filed as an infrastructure failure. An eval that
 * quietly skipped every trial whose prompt had changed would report a clean sheet for
 * exactly the change that most needed measuring.
 */
export class CassetteMissingError extends Error {
  constructor(
    readonly key: string,
    readonly llmId: string,
  ) {
    super(
      `no cassette ${key} for ${llmId} — the request changed, so the recording is stale. ` +
        'Re-record with `npm run evals -- --record --split test --reps 4`.',
    );
    this.name = 'CassetteMissingError';
  }
}

/**
 * Stable JSON: object keys sorted at every depth.
 *
 * `JSON.stringify` preserves insertion order, so the same request built by two code paths
 * could serialise differently and hash differently. A key that changes when nothing
 * changed would send CI red on a refactor, which is precisely the noise this is supposed
 * not to produce.
 */
function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;

  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`);
  return `{${entries.join(',')}}`;
}

/**
 * The cassette key.
 *
 * `variant` carries what the request object does not: the model seed, which lives in the
 * backend rather than in the call. Leaving it out would make four repetitions share one
 * cassette and quietly turn a four-rep run into the same answer four times.
 */
export function cassetteKey(llmId: string, variant: string, request: LlmRequest): string {
  const payload = canonical({ llm_id: llmId, variant, request });
  return createHash('sha256').update(payload).digest('hex').slice(0, 32);
}

export interface CassetteOptions {
  readonly dir: string;
  /** Anything outside the request that changes the answer. The model seed, in practice. */
  readonly variant: string;
}

/** Wraps a real backend, answering normally and writing what it saw. */
export function recordingLlm(inner: LlmPort, options: CassetteOptions): LlmPort {
  return {
    id: inner.id,

    async complete(request: LlmRequest): Promise<LlmResponse> {
      const response = await inner.complete(request);
      const key = cassetteKey(inner.id, options.variant, request);
      const cassette: Cassette = {
        key,
        llm_id: inner.id,
        variant: options.variant,
        recorded_at: new Date().toISOString(),
        request,
        response,
      };

      mkdirSync(options.dir, { recursive: true });
      writeFileSync(join(options.dir, `${key}.json`), JSON.stringify(cassette, null, 2) + '\n');
      return response;
    },
  };
}

/**
 * Answers from disk, or refuses.
 *
 * `id` is the backend it claims to be, and the recorded model is checked against it:
 * replaying a qwen cassette while the run reports itself as something else would put a
 * number under the wrong name, which is requirement 9 of the eval design and the kind of
 * mistake nobody notices until the comparison is already published.
 */
export function replayLlm(id: string, options: CassetteOptions): LlmPort {
  return {
    id,

    complete(request: LlmRequest): Promise<LlmResponse> {
      const key = cassetteKey(id, options.variant, request);
      const path = join(options.dir, `${key}.json`);
      if (!existsSync(path)) return Promise.reject(new CassetteMissingError(key, id));

      const cassette = JSON.parse(readFileSync(path, 'utf-8')) as Cassette;
      if (cassette.llm_id !== id) {
        return Promise.reject(
          new Error(`cassette ${key} was recorded from ${cassette.llm_id}, not ${id}`),
        );
      }
      return Promise.resolve(cassette.response);
    },
  };
}
