import { describe, expect, it } from 'vitest';
import { buildHttpRoutes } from '../src/adapters/primary/http-routes';
import { buildTriageStack } from '../src/composition';
import { SGC_TAME } from '../src/external-mocks/erp-profile';
import { seededDraw } from '../src/external-mocks/draw';
import { cents } from '../src/domain/money';
import { ErpUnavailableError } from '../src/ports/erp';
import { MalformedDecisionError, type DecisionMakerPort } from '../src/ports/triage';
import type { Proposal } from '../src/domain/decision';

/**
 * The HTTP adapter, driven through `app.fetch` — no server, no port, no socket.
 *
 * That is the same seam the simulated ERP is reached by, and the reason `Transport` is
 * the Fetch API itself: the code under test here is byte for byte the code that runs
 * behind a real listener. There is no `if (TESTING)` anywhere for it to take.
 *
 * The judgement comes from a stub decider, so the whole file runs with no model, no GPU
 * and no network — the same substitution the eval's four smoke policies use, through the
 * same port.
 */

const EVALUATED_AT = '2026-08-30T15:00:00Z';

function decider(proposal: Partial<Proposal> = {}): DecisionMakerPort {
  return {
    id: 'policy:test',
    propose: () =>
      Promise.resolve({
        action: 'refund',
        confidence: 0.95,
        amountCents: cents(4_829_000),
        reason: 'delivered, damaged, small amount, clean customer',
        evidence: ['shipment.state', 'history.claims_90d'],
        missingFacts: [],
        ...proposal,
      }),
  };
}

function app(decision: DecisionMakerPort = decider()) {
  return buildHttpRoutes(
    buildTriageStack({ profile: SGC_TAME, draw: seededDraw(7), decider: decision }),
  );
}

/**
 * `app.fetch` is typed as returning a Response OR a promise of one, so it is awaited
 * here once rather than at each of the fifteen call sites below.
 */
async function triage(routes: ReturnType<typeof app>, body: unknown): Promise<Response> {
  return routes.fetch(
    new Request('http://local/api/triage', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );
}

/**
 * The body of an HTTP response is `unknown` and the compiler is right about that.
 * Asserting a shape here is the test saying what it expects the contract to be, which is
 * the one place a cast is doing work rather than hiding something.
 */
interface TriageBody {
  decision: {
    action: string;
    executed: boolean;
    escalated_by: string | null;
    blocked_by: string[];
    amount_pesos: number | null;
  };
  guardrails: { ok: boolean; rule: string }[];
  facts: { order: { orderId: string }; shipment: { state: string }; missing: string[] };
  trace: { step: string }[];
  error?: string;
  issues?: string[];
}

const bodyOf = async (response: Response): Promise<TriageBody> =>
  (await response.json()) as TriageBody;

const INCIDENT = {
  order_id: 'FC-10241',
  kind: 'damaged',
  customer_message: 'Me llego la caja mojada y el producto no enciende.',
  evaluated_at: EVALUATED_AT,
};

describe('POST /api/triage', () => {
  it('runs the whole circuit and reports what was decided', async () => {
    const response = await triage(app(), INCIDENT);
    const body = await bodyOf(response);

    expect(response.status).toBe(200);
    expect(body.decision).toMatchObject({ action: 'refund', executed: true, escalated_by: null });
    expect(body.decision.amount_pesos).toBe(48_290);
  });

  it('returns the facts it read, including the ones it could not', async () => {
    // An operator reviewing a decision cannot tell bad reasoning from a hole in the data
    // unless the answer carries both.
    const body = await bodyOf(await triage(app(), INCIDENT));

    expect(body.facts.order.orderId).toBe('FC-10241');
    expect(body.facts.shipment.state).toBe('delivered');
    expect(body.facts).toHaveProperty('missing');
  });

  it('returns the trace, which is what this route exists to give a consumer', async () => {
    // TraceRecorder was written, tested and read by nothing in production. Every hop is
    // here: the input, the ERP reads, the model, the verdict.
    const body = await bodyOf(await triage(app(), INCIDENT));
    const steps = body.trace.map((e) => e.step);

    expect(steps[0]).toBe('input');
    expect(steps).toContain('erp');
    expect(steps.at(-1)).toBe('output');
  });

  it('says which rules ran, not only the ones that blocked', async () => {
    const body = await bodyOf(await triage(app(), INCIDENT));

    expect(body.guardrails.length).toBeGreaterThan(10);
    expect(body.guardrails.every((v) => v.ok)).toBe(true);
  });

  it('separates an escalation the model chose from one it was stopped by', async () => {
    // The distinction the whole project turns on, and an operator staring at a queue of
    // escalations is the first person who needs it.
    const stopped = await bodyOf(
      await triage(app(decider({ action: 'refund', confidence: 0.2 })), INCIDENT),
    );
    const chosen = await bodyOf(
      await triage(app(decider({ action: 'escalate', amountCents: null })), INCIDENT),
    );

    expect(stopped.decision).toMatchObject({ executed: false, escalated_by: 'guardrail' });
    expect(stopped.decision.blocked_by).toContain('confidence-floor');
    expect(chosen.decision).toMatchObject({ executed: false, escalated_by: 'model' });
    expect(chosen.decision.blocked_by).toEqual([]);
  });
});

describe('a request that is not what the API accepts', () => {
  it('rejects a body that is not JSON', async () => {
    const response = await app().fetch(
      new Request('http://local/api/triage', { method: 'POST', body: 'not json' }),
    );

    expect(response.status).toBe(400);
  });

  it('rejects an unknown claim type and says which field', async () => {
    const response = await triage(app(), { ...INCIDENT, kind: 'exploded' });
    const body = await bodyOf(response);

    expect(response.status).toBe(400);
    expect(body.issues?.join(' ')).toContain('kind');
  });

  it('rejects a field nobody asked for', async () => {
    // strictObject. An unknown field is a caller who believes this API does something it
    // does not, and answering 200 is how that misunderstanding reaches production.
    const response = await triage(app(), { ...INCIDENT, refund_now: true });

    expect(response.status).toBe(400);
  });
});

describe('when something downstream fails', () => {
  const throwing = (error: Error): DecisionMakerPort => ({
    id: 'policy:throws',
    propose: () => Promise.reject(error),
  });

  it('answers 503 when the model could not be reached, not 500', async () => {
    // The three failure modes get three answers on purpose: an unreachable ERP, a model
    // that answered badly and a bug here are different problems, and whoever is on call
    // should not have to guess which one they have.
    const routes = app(throwing(new ErpUnavailableError('shipment', 'four 429s', 4)));
    const response = await triage(routes, INCIDENT);

    expect(response.status).toBe(503);
    expect((await bodyOf(response)).error).toBe('erp_unavailable');
  });

  it('answers 502 when the model produced nothing usable', async () => {
    const routes = app(throwing(new MalformedDecisionError('test', ['no tool call'], '')));
    const response = await triage(routes, INCIDENT);

    expect(response.status).toBe(502);
    expect((await bodyOf(response)).error).toBe('model_answered_badly');
  });

  it('returns the trace on the failure path too', async () => {
    // A request that died four hops in is exactly the one somebody needs the hops for.
    const routes = app(throwing(new ErpUnavailableError('shipment', 'four 429s', 4)));
    const body = await bodyOf(await triage(routes, INCIDENT));

    expect(body.trace.length).toBeGreaterThan(0);
  });
});

describe('GET /health', () => {
  it('says which ERP it is talking to, because the default is a simulation', async () => {
    const body = (await (await app().fetch(new Request('http://local/health'))).json()) as {
      ok: boolean;
      erp: string;
      decider: string;
    };

    expect(body).toMatchObject({ ok: true, erp: 'simulated', decider: 'policy:test' });
  });
});
