import { Hono } from 'hono';
import type { DateFormat, ErpProfile } from './erp-profile';
import { BASE_SEED, cloneSeed, type ErpSeed } from './erp-seed';
import { systemDraw, type Draw } from './draw';
// The simulator and the wire parser are the two sides of one contract, so the offset
// they must agree on is defined once, in the domain, where both may import it and
// neither owns it.
import { ART_OFFSET_HOURS, HOUR_MS } from '../domain/time';

/**
 * SGC, the simulated legacy ERP.
 *
 * It is a separate Hono app that is never mounted on the main one. The only way to
 * reach it is its own `fetch`, which has the standard Fetch API signature. That is what
 * lets the adapter run the same code in the demo and in the tests: no sockets, no test
 * library, and no `if (TESTING)` branch.
 *
 * `buildMocksApp` is a FACTORY, not a singleton: every eval trial and every test builds
 * its own with its own copy of the seed and its own session, so one case's state never
 * leaks into the next, not even in parallel.
 *
 * The hostilities are not written here — they live in the profile. This file asks.
 */

const TRUNCATION_KEEP = 0.6;

/** How much bigger than reality the declared total is, when the profile lies. */
const LYING_TOTAL_FACTOR = 4;

export interface MocksOptions {
  readonly profile: ErpProfile;
  readonly seed?: ErpSeed;
  readonly draw?: Draw;
}

export function buildMocksApp({ profile, seed, draw = systemDraw }: MocksOptions): Hono {
  const state = cloneSeed(seed ?? BASE_SEED);
  /**
   * `token|path` -> calls remaining. `Infinity` when the profile never expires sessions.
   *
   * Per endpoint rather than per token, and that is the point. A single budget shared by
   * the shipment, the history and the notes — which go out together — is a race: whoever
   * arrives last takes the 401, and after a retry backoff on real timers "last" is not
   * always the same one. The adapter's job is unchanged (a 401 arrives mid-batch and it
   * must re-login without losing the request); what changes is that WHICH request gets
   * it no longer depends on the machine's mood.
   */
  const sessions = new Map<string, number>();
  /**
   * `requestKey` -> attempts so far, so the die can be told them apart.
   *
   * A keyed die returns the same number for the same key, so a retried request would
   * draw the same 429 forever. Retries of one request are strictly sequential — the
   * adapter awaits its backoff before trying again — so counting them here is safe in a
   * way that counting all requests is not.
   */
  const attempts = new Map<string, number>();
  /**
   * Tokens this app issued.
   *
   * Needed because the per-endpoint budget is allocated lazily, on first use: without a
   * record of what was handed out, any well-formed token would be honoured — including
   * one from another instance, which would quietly share state between eval trials that
   * are supposed to be independent.
   */
  const issuedTokens = new Set<string>();
  let issued = 0;

  const app = new Hono();

  // --- Cross-cutting, once: latency, session, quota and truncation. ----------------

  app.use('*', async (c, next) => {
    // Everything this request draws is keyed on the request and its attempt number, so
    // two reads racing each other cannot swap outcomes.
    const request = `${c.req.method} ${c.req.path}?${new URL(c.req.url).searchParams}`;
    const attempt = (attempts.get(request) ?? 0) + 1;
    attempts.set(request, attempt);
    const key = (what: string): string => `${request}#${attempt}#${what}`;

    await sleep(jitter(profile.latencyMs, draw, key('latency')));

    if (
      c.req.path !== '/sgc/auth' &&
      !consumeSession(sessions, issuedTokens, c.req.header('X-SGC-Token'), c.req.path, profile)
    ) {
      // Hostility 2: the token runs out mid-batch, not at the start.
      return c.json({ error: 'sesion vencida o inexistente' }, 401);
    }

    if (draw(key('rate')) < profile.rateLimitProbability) {
      // Hostility 3: `Retry-After` in seconds or as an HTTP date, per the profile.
      const retryAfter = profile.retryAfterAsHttpDate
        ? new Date(Date.now() + profile.retryAfterSeconds * 1000).toUTCString()
        : String(profile.retryAfterSeconds);
      return c.json({ error: 'demasiadas consultas' }, 429, { 'Retry-After': retryAfter });
    }

    await next();

    // Hostility 4: 200 with a cut body. The status lies and the JSON blows up.
    if (c.res.status === 200 && draw(key('truncate')) < profile.truncationProbability) {
      const body = await c.res.clone().text();
      const cut = body.slice(0, Math.max(1, Math.floor(body.length * TRUNCATION_KEEP)));
      c.res = new Response(cut, { status: 200, headers: c.res.headers });
    }
  });

  // --- Endpoints. Paths and payload keys are SGC's own vocabulary. -----------------

  app.post('/sgc/auth', (c) => {
    issued += 1;
    const token = `sess-${issued}`;
    // The per-endpoint budget is allocated lazily on first use — see `sessions`.
    issuedTokens.add(token);
    return c.json({ token, expira_en: 900 });
  });

  /** Hostility 1: this endpoint speaks XML. The other four speak JSON. */
  app.get('/sgc/pedido', (c) => {
    const order = state.orders[c.req.query('nro') ?? ''];
    if (!order) {
      return c.body(xml('<error>pedido inexistente</error>'), 404, {
        'Content-Type': 'application/xml; charset=utf-8',
      });
    }
    const body = xml(
      '<pedido>' +
        tag('nro', order.nro) +
        tag('tipo_doc', order.tipo_doc) +
        tag('total', order.total) +
        tag('fecha', formatDate(order.fecha, profile.dateFormats.order)) +
        tag('cliente_doc', order.cliente_doc) +
        tag('guia', order.guia ?? String(renderNull(profile, draw, `${order.nro}.guia`) ?? '')) +
        '</pedido>',
    );
    return c.body(body, 200, { 'Content-Type': 'application/xml; charset=utf-8' });
  });

  app.get('/sgc/envio', (c) => {
    const shipment = state.shipments[c.req.query('guia') ?? ''];
    if (!shipment) return c.json({ error: 'guia inexistente' }, 404);
    return c.json({
      guia: shipment.guia,
      // Hostility 6: this number means nothing without `tipo_doc` from the OTHER endpoint.
      estado: shipment.estado,
      transportista: shipment.transportista,
      promesa: shipment.promesa
        ? formatDate(shipment.promesa, profile.dateFormats.shipment)
        : renderNull(profile, draw, `${shipment.guia}.promesa`),
      ultimo_evento: shipment.ultimo_evento
        ? formatDate(shipment.ultimo_evento, profile.dateFormats.shipment)
        : renderNull(profile, draw, `${shipment.guia}.ultimo_evento`),
    });
  });

  /** Hostility 7: the `total` lies and out-of-range pages wrap around. */
  app.get('/sgc/cliente/historial', (c) => {
    const customer = state.customers[c.req.query('doc') ?? ''];
    if (!customer) return c.json({ error: 'cliente inexistente' }, 404);

    const all = customer.movimientos;
    const pages = Math.max(1, Math.ceil(all.length / profile.pageSize));
    const asked = Math.max(1, Number(c.req.query('pagina') ?? '1') || 1);
    const effective = profile.wrapsAroundPages && asked > pages ? 1 : asked;
    const start = (effective - 1) * profile.pageSize;

    return c.json({
      doc: customer.doc,
      pagina: asked,
      por_pagina: profile.pageSize,
      // Four times the real count: a naive reader that pages "until it reaches the
      // total" never finishes, because page 4 also hands back page 1.
      total: profile.lyingTotal ? all.length * LYING_TOTAL_FACTOR : all.length,
      items: all.slice(start, start + profile.pageSize).map((m) => ({
        tipo: m.tipo,
        fecha: formatDate(m.fecha, profile.dateFormats.shipment),
        monto: m.monto,
      })),
    });
  });

  app.get('/sgc/notas', (c) => {
    const orderId = c.req.query('pedido') ?? '';
    // An unknown order 404s here too. Answering 200 with an empty list for anything
    // asked made the adapter's 404 branch unreachable, so a path that runs against a
    // real ERP was never exercised against the simulated one.
    if (!(orderId in state.orders)) return c.json({ error: 'pedido inexistente' }, 404);
    return c.json({
      pedido: orderId,
      items: state.notes
        .filter((n) => n.pedido === orderId)
        .map((n) => ({
          texto: n.texto,
          fecha: formatDate(n.fecha, profile.dateFormats.notes),
        })),
    });
  });

  return app;
}

// --- Helpers ---------------------------------------------------------------------

function consumeSession(
  sessions: Map<string, number>,
  issuedTokens: ReadonlySet<string>,
  token: string | undefined,
  path: string,
  profile: ErpProfile,
): boolean {
  if (!token || !issuedTokens.has(token)) return false;

  const slot = `${token}|${path}`;
  const left = sessions.get(slot) ?? (profile.sessionMaxCalls === 0 ? Infinity : profile.sessionMaxCalls);
  if (left <= 0) return false;
  sessions.set(slot, left - 1);
  return true;
}

function jitter([min, max]: readonly [number, number], draw: Draw, key: string): number {
  return min === max ? min : min + draw(key) * (max - min);
}

const sleep = (ms: number): Promise<void> =>
  ms <= 0 ? Promise.resolve() : new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Hostility 5: rotates through the profile's shapes of "no value".
 *
 * Keyed on the field it is rendering, so the same absent value looks the same however
 * many times it is read and whatever else was read alongside it.
 */
function renderNull(profile: ErpProfile, draw: Draw, key: string): string | null | undefined {
  const styles = profile.nullStyles;
  if (styles.length === 0) return null;
  return styles[Math.min(styles.length - 1, Math.floor(draw(key) * styles.length))];
}

/** Hostility 8: three formats, and the two readable ones carry no timezone. */
function formatDate(date: Date, format: DateFormat): string {
  if (format === 'epoch') return String(Math.floor(date.getTime() / 1000));

  const local = new Date(date.getTime() + ART_OFFSET_HOURS * HOUR_MS);
  const pad = (n: number): string => String(n).padStart(2, '0');
  const [year, month, day, hour, minute, second] = [
    local.getUTCFullYear(),
    pad(local.getUTCMonth() + 1),
    pad(local.getUTCDate()),
    pad(local.getUTCHours()),
    pad(local.getUTCMinutes()),
    pad(local.getUTCSeconds()),
  ] as const;

  return format === 'dmy'
    ? `${day}/${month}/${year} ${hour}:${minute}`
    : `${year}-${month}-${day}T${hour}:${minute}:${second}`;
}

const xml = (inner: string): string =>
  `<?xml version="1.0" encoding="UTF-8"?><respuesta>${inner}</respuesta>`;

const tag = (name: string, value: string): string => `<${name}>${escapeXml(value)}</${name}>`;

const escapeXml = (value: string): string =>
  value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
