import type { Transport } from '../../core/transport';
import type { Tracer } from '../../domain/trace';
import {
  ERP_MAX_ATTEMPTS,
  ERP_MAX_BACKOFF_MS,
  ERP_TIMEOUT_MS,
  ErpUnavailableError,
} from '../../ports/erp';

/**
 * Where SGC's cross-cutting hostilities die.
 *
 * Five of the ten belong to every endpoint rather than to one, so they are solved once
 * here and no endpoint thinks about them again:
 *
 *   2. session expiring mid-batch  -> transparent re-login, without losing the request
 *   3. 429 with `Retry-After`      -> backoff that understands seconds and HTTP dates
 *   4. 200 with a cut body         -> detected and retried
 *  10. latency                     -> hard timeout per attempt
 *
 * The other five are about shape (XML, nulls, ambiguous state, dates, amounts) and are
 * solved in each endpoint's mapping.
 */

const DEFAULT_BACKOFF_MS = 250;

/**
 * Hostility 3: `Retry-After` arrives in seconds or as an HTTP date, depending on the
 * ERP's mood. A pure function, so both shapes can be tested without starting anything.
 */
export function parseRetryAfter(value: string | null, now: Date): number {
  if (!value) return DEFAULT_BACKOFF_MS;

  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) return Math.min(Number(trimmed) * 1000, ERP_MAX_BACKOFF_MS);

  const when = Date.parse(trimmed);
  if (Number.isNaN(when)) return DEFAULT_BACKOFF_MS;
  return Math.min(Math.max(0, when - now.getTime()), ERP_MAX_BACKOFF_MS);
}

/** Each endpoint says what a whole body looks like; the session knows no formats. */
export type IsComplete = (body: string) => boolean;

/** Hostility 4 for JSON: if it does not parse, it arrived cut. */
export const jsonIsComplete: IsComplete = (body) => {
  try {
    JSON.parse(body);
    return true;
  } catch {
    return false;
  }
};

/** Hostility 4 for XML: the envelope has to close. */
export const xmlIsComplete: IsComplete = (body) => body.trimEnd().endsWith('</respuesta>');

export interface SgcResponse {
  readonly body: string;
  readonly status: number;
}

export class SgcSession {
  private token: string | null = null;

  /**
   * The login currently in flight, if any.
   *
   * Without it, three concurrent reads that all see `token === null` all issue their own
   * `POST /sgc/auth` — measured: 3 logins where 1 was enough, and 6 after a mid-batch
   * 401. Against a profile that expires the session every 4 calls, those extra logins
   * eat the very quota the reads need.
   */
  private pendingLogin: Promise<void> | null = null;

  constructor(
    private readonly transport: Transport,
    private readonly baseUrl = 'http://sgc',
    private readonly now: () => Date = () => new Date(),
  ) {}

  /**
   * A GET with everything cross-cutting applied. Returns the whole body or throws
   * `ErpUnavailableError` after exhausting the attempts.
   *
   * A 404 is NOT an error: it means "that does not exist", and the caller turns it into
   * a `null` plus a missing fact. Confusing "does not exist" with "I could not ask" is
   * the same mistake as confusing "no answer" with "the answer is no".
   */
  async get(
    endpoint: string,
    path: string,
    query: Record<string, string>,
    isComplete: IsComplete,
    tracer: Tracer,
  ): Promise<SgcResponse> {
    let lastProblem = 'no attempts made';

    for (let attempt = 1; attempt <= ERP_MAX_ATTEMPTS; attempt++) {
      let usedToken: string;
      try {
        usedToken = await this.ensureToken(tracer);
      } catch (error) {
        // A failed login is retried like anything else, but its real cause is kept.
        // Swallowing it used to produce the worst kind of error message: the request
        // went out unauthenticated, earned a guaranteed 401, and the run ended saying
        // "session expired" when the truth was that the login had been rate limited.
        lastProblem = error instanceof ErpUnavailableError ? error.message : String(error);
        tracer.mark('retry', 'auth', `attempt ${attempt}: ${lastProblem}`);
        await sleep(DEFAULT_BACKOFF_MS);
        continue;
      }

      const url = new URL(path, this.baseUrl);
      for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);

      const response = await this.send(
        endpoint,
        new Request(url, {
          headers: { 'X-SGC-Token': usedToken },
          // The AbortSignal is not decorative: a fetch without a timeout against a
          // foreign system hangs silently and leaves no line in the log.
          signal: AbortSignal.timeout(ERP_TIMEOUT_MS),
        }),
        attempt,
        tracer,
      );

      if (response.status === 401) {
        // Hostility 2: the token ran out mid-batch. It is renewed and THIS request is
        // repeated; the caller never finds out we had to log in again.
        //
        // Only the token this request actually used is discarded. Clearing
        // unconditionally would throw away a fresher one that a concurrent read had just
        // obtained, turning one expiry into a cascade of them.
        if (this.token === usedToken) this.token = null;
        lastProblem = 'session expired';
        tracer.mark('retry', `${endpoint} 401`, `attempt ${attempt}: re-login`);
        continue;
      }

      if (response.status === 429) {
        const waitMs = parseRetryAfter(response.headers.get('Retry-After'), this.now());
        lastProblem = 'rate limited';
        tracer.mark('retry', `${endpoint} 429`, `attempt ${attempt}: waiting ${waitMs}ms`);
        await sleep(waitMs);
        continue;
      }

      const body = await response.text();

      if (response.status === 404) return { body, status: 404 };

      if (!response.ok) {
        lastProblem = `HTTP ${response.status}`;
        tracer.mark('retry', `${endpoint} ${response.status}`, `attempt ${attempt}`);
        await sleep(DEFAULT_BACKOFF_MS);
        continue;
      }

      if (!isComplete(body)) {
        // Hostility 4: status 200 and a cut body. Swallowing it would be worse than
        // failing, because incomplete data looks exactly like good data further down.
        lastProblem = `incomplete body (${body.length} bytes)`;
        tracer.mark('retry', `${endpoint} truncated`, `attempt ${attempt}: ${body.length} bytes`);
        await sleep(DEFAULT_BACKOFF_MS);
        continue;
      }

      tracer.mark('erp', endpoint, `${response.status} in ${attempt} attempt(s)`);
      return { body, status: response.status };
    }

    tracer.mark('error', endpoint, lastProblem);
    throw new ErpUnavailableError(endpoint, lastProblem, ERP_MAX_ATTEMPTS);
  }

  /**
   * Ensures there is a token and RETURNS it, coalescing concurrent callers onto one login.
   *
   * Returning the token instead of leaving the caller to re-read `this.token` closes a
   * window: between the await finishing and the field being read, a concurrent request
   * that got a 401 can null it, and the request would go out with no header at all —
   * earning a 401 of its own and burning one of the four attempts.
   */
  private async ensureToken(tracer: Tracer): Promise<string> {
    if (this.token !== null) return this.token;

    this.pendingLogin ??= this.login(tracer).finally(() => {
      this.pendingLogin = null;
    });
    await this.pendingLogin;

    // The login resolved without setting a token only if another caller's 401 cleared it
    // in between. Treated as a failure so the loop retries rather than sending a headless
    // request.
    if (this.token === null) {
      throw new ErpUnavailableError('auth', 'the token was cleared before it could be used', 1);
    }
    return this.token;
  }

  /**
   * Logs in, or throws with the actual reason.
   *
   * Every failure mode here is reported rather than swallowed: SGC throttles the login
   * endpoint like any other, and it can truncate that response too.
   */
  private async login(tracer: Tracer): Promise<void> {
    const response = await this.send(
      'auth',
      new Request(new URL('/sgc/auth', this.baseUrl), {
        method: 'POST',
        signal: AbortSignal.timeout(ERP_TIMEOUT_MS),
      }),
      1,
      tracer,
    );

    if (!response.ok) {
      throw new ErpUnavailableError('auth', `login returned HTTP ${response.status}`, 1);
    }

    const body = await response.text();
    if (!jsonIsComplete(body)) {
      throw new ErpUnavailableError('auth', 'login response arrived truncated', 1);
    }

    const parsed = JSON.parse(body) as { token?: unknown };
    if (typeof parsed.token !== 'string') {
      throw new ErpUnavailableError('auth', 'login response carried no token', 1);
    }
    this.token = parsed.token;
  }

  private async send(
    endpoint: string,
    request: Request,
    attempt: number,
    tracer: Tracer,
  ): Promise<Response> {
    try {
      return await this.transport(request);
    } catch (cause) {
      tracer.mark('error', endpoint, `transport down on attempt ${attempt}`);
      throw new ErpUnavailableError(endpoint, describe(cause), attempt);
    }
  }
}

const sleep = (ms: number): Promise<void> =>
  ms <= 0 ? Promise.resolve() : new Promise((resolve) => setTimeout(resolve, ms));

const describe = (cause: unknown): string =>
  cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause);
