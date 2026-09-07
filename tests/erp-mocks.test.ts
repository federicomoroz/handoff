import { describe, expect, it } from 'vitest';
import { buildMocksApp } from '../src/external-mocks/erp-mocks';
import { SGC_HOSTILE, SGC_TAME, type ErpProfile } from '../src/external-mocks/erp-profile';
import { constantDraw, seededDraw } from '../src/external-mocks/draw';
import { BASE_SEED } from '../src/external-mocks/erp-seed';

/**
 * Tests for the simulator: they verify the ERP misbehaves the way the profile promises.
 *
 * The adapter that resolves these hostilities is tested separately. What is proven here
 * is that the hostility EXISTS — a simulator that never gets in the way would make
 * everything downstream pointless.
 */

/** `draw` pinned at 0.99: no 429s and no truncation, so each test isolates one thing. */
function app(profile: ErpProfile, draw = constantDraw(0.99)) {
  return buildMocksApp({ profile, seed: BASE_SEED, draw });
}

/**
 * A movable `draw`: benign while authenticating, hostile afterwards.
 *
 * Needed because `POST /sgc/auth` goes through the same hostilities as everything else —
 * on purpose, a real ERP throttles logins too — so with the die pinned to hostile you
 * never get a token at all.
 */
function dial(initial = 0.99) {
  const state = { value: initial };
  return { draw: () => state.value, set: (value: number) => (state.value = value) };
}

async function authed(a: ReturnType<typeof app>): Promise<string> {
  const res = await a.request('/sgc/auth', { method: 'POST' });
  const body = (await res.json()) as { token: string };
  return body.token;
}

const get = (a: ReturnType<typeof app>, path: string, token: string) =>
  a.request(path, { headers: { 'X-SGC-Token': token } });

describe('session — hostility 2', () => {
  it('no token, no entry', async () => {
    const a = app(SGC_HOSTILE);
    expect((await a.request('/sgc/pedido?nro=FC-10241')).status).toBe(401);
  });

  it('the token runs out mid-batch, not at the start', async () => {
    const a = app(SGC_HOSTILE);
    const token = await authed(a);

    // sessionMaxCalls = 4: the first four pass, the fifth falls over.
    for (let i = 0; i < SGC_HOSTILE.sessionMaxCalls; i++) {
      expect((await get(a, '/sgc/pedido?nro=FC-10241', token)).status).toBe(200);
    }
    expect((await get(a, '/sgc/pedido?nro=FC-10241', token)).status).toBe(401);
  });

  it('the tame profile never expires', async () => {
    const a = app(SGC_TAME);
    const token = await authed(a);
    for (let i = 0; i < 25; i++) {
      expect((await get(a, '/sgc/pedido?nro=FC-10241', token)).status).toBe(200);
    }
  });
});

describe('rate limit — hostility 3', () => {
  it('returns 429 with Retry-After as an HTTP date', async () => {
    const d = dial();
    const a = buildMocksApp({ profile: SGC_HOSTILE, seed: BASE_SEED, draw: d.draw });
    const token = await authed(a);

    d.set(0.01);
    const res = await get(a, '/sgc/pedido?nro=FC-10241', token);

    expect(res.status).toBe(429);
    const retryAfter = res.headers.get('Retry-After') ?? '';
    expect(Number.isNaN(Date.parse(retryAfter))).toBe(false);
  });

  it('the tame profile never throttles', async () => {
    const a = app(SGC_TAME, constantDraw(0.0));
    const token = await authed(a);
    expect((await get(a, '/sgc/pedido?nro=FC-10241', token)).status).toBe(200);
  });
});

describe('truncation — hostility 4', () => {
  it('returns 200 with a cut body, so the JSON does not parse', async () => {
    // Rate limiting is switched off so the 429 does not win first; truncation stays at
    // the profile's real 0.08 and is triggered by the die, not by a value invented for
    // the test.
    const profile: ErpProfile = { ...SGC_HOSTILE, rateLimitProbability: 0 };
    const d = dial();
    const a = buildMocksApp({ profile, seed: BASE_SEED, draw: d.draw });
    const token = await authed(a);

    d.set(0.01);
    const res = await get(a, '/sgc/envio?guia=OCA-889', token);

    expect(res.status).toBe(200);
    await expect(res.json()).rejects.toThrow();
  });
});

describe('order in XML — hostility 1', () => {
  it('speaks XML while the rest speaks JSON', async () => {
    const a = app(SGC_HOSTILE);
    const token = await authed(a);
    const res = await get(a, '/sgc/pedido?nro=FC-10241', token);

    expect(res.headers.get('Content-Type')).toContain('xml');
    const body = await res.text();
    expect(body).toContain('<tipo_doc>FC</tipo_doc>');
    expect(body).toContain('<total>48.290,00</total>');
    expect(body).toMatch(/<fecha>\d{2}\/\d{2}\/\d{4} \d{2}:\d{2}<\/fecha>/);
  });
});

describe('ambiguous state — hostility 6', () => {
  it('two shipments carry the same state 3 under different document types', async () => {
    const a = app(SGC_TAME);
    const token = await authed(a);

    const invoice = await (await get(a, '/sgc/envio?guia=OCA-889', token)).json();
    const creditNote = await (await get(a, '/sgc/envio?guia=OCA-902', token)).json();

    // The ERP does not distinguish: it sends the same 3 in both cases. The difference
    // lives in `tipo_doc`, which is on the order endpoint.
    expect((invoice as { estado: number }).estado).toBe(3);
    expect((creditNote as { estado: number }).estado).toBe(3);
  });
});

describe('lying pagination — hostility 7', () => {
  it('declares a total four times larger than what it has', async () => {
    const a = app(SGC_HOSTILE);
    const token = await authed(a);
    const body = (await (
      await get(a, '/sgc/cliente/historial?doc=27111222&pagina=1', token)
    ).json()) as { total: number; items: unknown[] };

    const real = BASE_SEED.customers['27111222']!.movimientos.length;
    expect(body.total).toBe(real * 4);
    expect(body.items).toHaveLength(SGC_HOSTILE.pageSize);
  });

  it('an out-of-range page returns the first one, not an empty one', async () => {
    const a = app(SGC_HOSTILE);
    const token = await authed(a);

    const first = (await (
      await get(a, '/sgc/cliente/historial?doc=27111222&pagina=1', token)
    ).json()) as { items: unknown[] };
    const beyond = (await (
      await get(a, '/sgc/cliente/historial?doc=27111222&pagina=9', token)
    ).json()) as { items: unknown[] };

    // A reader that pages "until it reaches the total" never finishes with this ERP.
    expect(beyond.items).toEqual(first.items);
  });

  it('the tame profile tells the truth and does not wrap around', async () => {
    const a = app(SGC_TAME);
    const token = await authed(a);
    const body = (await (
      await get(a, '/sgc/cliente/historial?doc=27111222&pagina=9', token)
    ).json()) as { total: number; items: unknown[] };

    expect(body.total).toBe(BASE_SEED.customers['27111222']!.movimientos.length);
    expect(body.items).toHaveLength(0);
  });
});

describe('isolation between instances', () => {
  it('each app owns its seed and its session', async () => {
    const a = app(SGC_HOSTILE, seededDraw(1));
    const b = app(SGC_HOSTILE, seededDraw(1));

    const tokenA = await authed(a);
    // A's token is useless on B: no state is shared between instances.
    expect((await get(b, '/sgc/pedido?nro=FC-10241', tokenA)).status).toBe(401);
  });
});
