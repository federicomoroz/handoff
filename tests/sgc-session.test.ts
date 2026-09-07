import { describe, expect, it } from 'vitest';
import {
  jsonIsComplete,
  parseRetryAfter,
  SgcSession,
  xmlIsComplete,
} from '../src/adapters/secondary/sgc-session';
import { ERP_MAX_BACKOFF_MS } from '../src/ports/erp';
import { NULL_TRACER } from '../src/domain/trace';
import type { Transport } from '../src/core/transport';

const NOW = new Date('2026-08-30T15:00:00Z');

describe('parseRetryAfter — hostility 3', () => {
  it('reads the seconds format', () => {
    expect(parseRetryAfter('1', NOW)).toBe(1000);
    expect(parseRetryAfter('  2  ', NOW)).toBe(2000);
  });

  it('reads the HTTP date format, which is what breaks naive parsers', () => {
    const inOneSecond = new Date(NOW.getTime() + 1000).toUTCString();
    expect(parseRetryAfter(inOneSecond, NOW)).toBe(1000);
  });

  it('a date already in the past waits nothing instead of going negative', () => {
    const past = new Date(NOW.getTime() - 60_000).toUTCString();
    expect(parseRetryAfter(past, NOW)).toBe(0);
  });

  it('caps long waits so a hostile Retry-After cannot stall everything', () => {
    expect(parseRetryAfter('3600', NOW)).toBe(ERP_MAX_BACKOFF_MS);
  });

  it('falls back to a default backoff when the header is missing or junk', () => {
    expect(parseRetryAfter(null, NOW)).toBeGreaterThan(0);
    expect(parseRetryAfter('whenever', NOW)).toBeGreaterThan(0);
  });
});

describe('incomplete body detection — hostility 4', () => {
  it('a cut JSON is not complete', () => {
    expect(jsonIsComplete('{"guia":"OCA-889","estado":3}')).toBe(true);
    expect(jsonIsComplete('{"guia":"OCA-8')).toBe(false);
  });

  it('an XML with an unclosed envelope is not complete', () => {
    expect(xmlIsComplete('<respuesta><pedido/></respuesta>')).toBe(true);
    expect(xmlIsComplete('<respuesta><pedido><nro>FC-1')).toBe(false);
  });
});

describe('concurrent reads (regression)', () => {
  /** Counts what actually reached the wire, so the assertions are about traffic. */
  function countingTransport() {
    const hits: string[] = [];
    const transport: Transport = async (req) => {
      const path = new URL(req.url).pathname;
      hits.push(path);
      if (path === '/sgc/auth') {
        return new Response(JSON.stringify({ token: `sess-${hits.length}` }), { status: 200 });
      }
      return new Response('{"ok":true}', { status: 200 });
    };
    return { transport, hits };
  }

  it('three concurrent reads share ONE login', async () => {
    // Before: each read saw `token === null` and issued its own POST /sgc/auth. Against
    // a profile that expires the session every 4 calls, those extra logins ate the quota
    // the reads themselves needed.
    const { transport, hits } = countingTransport();
    const session = new SgcSession(transport);

    await Promise.all([
      session.get('a', '/sgc/pedido', {}, jsonIsComplete, NULL_TRACER),
      session.get('b', '/sgc/envio', {}, jsonIsComplete, NULL_TRACER),
      session.get('c', '/sgc/notas', {}, jsonIsComplete, NULL_TRACER),
    ]);

    expect(hits.filter((h) => h === '/sgc/auth')).toHaveLength(1);
  });

  it('a login that keeps failing reports the real cause, not "session expired"', async () => {
    const transport: Transport = async (req) =>
      new URL(req.url).pathname === '/sgc/auth'
        ? new Response('too many requests', { status: 429 })
        : new Response('{"ok":true}', { status: 200 });

    await expect(
      new SgcSession(transport).get('order', '/sgc/pedido', {}, jsonIsComplete, NULL_TRACER),
    ).rejects.toThrow(/login returned HTTP 429/);
  });

  it('a truncated login response is not mistaken for a token', async () => {
    const transport: Transport = async (req) =>
      new URL(req.url).pathname === '/sgc/auth'
        ? new Response('{"token":"sess-', { status: 200 })
        : new Response('{"ok":true}', { status: 200 });

    await expect(
      new SgcSession(transport).get('order', '/sgc/pedido', {}, jsonIsComplete, NULL_TRACER),
    ).rejects.toThrow(/truncated/);
  });
});
