import { addCents, cents, type Cents } from '../../domain/money';
import type { CustomerHistoryFacts, OrderFacts, ShipmentFacts } from '../../domain/facts';
import { DAY_MS } from '../../domain/time';
import type { Tracer } from '../../domain/trace';
import type { ErpPort } from '../../ports/erp';
import { jsonIsComplete, SgcSession, xmlIsComplete } from './sgc-session';
import {
  normalizeNullable,
  parseDocType,
  parseSgcAmount,
  parseSgcDate,
  resolveShipmentState,
} from './sgc-wire';

/**
 * The SGC adapter: five reads, each translating what the ERP emits into what the domain
 * understands.
 *
 * `SgcSession` already handled the cross-cutting part (session, 429, truncation,
 * timeout). What is left here is shape: XML, inconsistent nulls, the ambiguous state
 * code, three date formats, comma-decimal amounts, and the lying pagination.
 *
 * All of it has ONE correct answer, so the code does it. The model receives clean facts
 * and is left with nothing but the judgement.
 */

/** The history window. It lives here because it is a rule of this ERP, not of the domain. */
const HISTORY_WINDOW_DAYS = 90;

/**
 * Page cap. Hostility 7: SGC declares a total four times larger than what it has, and an
 * out-of-range page hands back the first one, so a reader that pages "until it reaches
 * the total" never finishes. The real stop is repetition detection; this is the belt in
 * case the ERP invents a new way to lie.
 */
const HISTORY_MAX_PAGES = 10;

// The `Wire*` shapes below keep SGC's Spanish keys because they must match the foreign
// payload byte for byte. They are a typed view of someone else's JSON, not our model.

interface WireShipment {
  readonly guia?: unknown;
  readonly estado?: unknown;
  readonly transportista?: unknown;
  readonly promesa?: unknown;
  readonly ultimo_evento?: unknown;
}

interface WireMovement {
  readonly tipo?: unknown;
  readonly fecha?: unknown;
  readonly monto?: unknown;
}

interface WireHistoryPage {
  readonly items?: readonly WireMovement[];
  readonly por_pagina?: unknown;
}

interface WireNotes {
  readonly items?: readonly { readonly texto?: unknown; readonly fecha?: unknown }[];
}

export function buildSgcErpAdapter(session: SgcSession): ErpPort {
  return {
    async fetchOrder(orderId, tracer) {
      const { body, status } = await session.get(
        'order',
        '/sgc/pedido',
        { nro: orderId },
        xmlIsComplete,
        tracer,
      );
      if (status === 404) return null;

      // Hostility 1: this endpoint speaks XML. This repo generates that XML, so a regex
      // is enough; against a real ERP this would be a proper parser.
      const docType = parseDocType(xmlField(body, 'tipo_doc'));
      const total = parseSgcAmount(xmlField(body, 'total'));
      const customerDoc = normalizeNullable(xmlField(body, 'cliente_doc'));

      // Without a document type or a total the order is useless for deciding anything.
      // It returns `null` and the caller records it as a missing fact.
      if (docType === null || total === null || customerDoc === null) return null;

      const facts: OrderFacts = {
        orderId,
        docType,
        total,
        placedAt: parseSgcDate(xmlField(body, 'fecha')),
        customerDoc,
        trackingId: normalizeNullable(xmlField(body, 'guia')),
      };
      return facts;
    },

    async fetchShipment(trackingId, docType, tracer) {
      const { body, status } = await session.get(
        'shipment',
        '/sgc/envio',
        { guia: trackingId },
        jsonIsComplete,
        tracer,
      );
      if (status === 404) return null;

      const wire = JSON.parse(body) as WireShipment;

      // Hostility 6: the number that arrived here means nothing without the `tipo_doc`
      // that came from the OTHER endpoint. Without a resolved state there is no usable
      // shipment: the allowlist guardrail decides on this field.
      const state = resolveShipmentState(wire.estado, docType);
      if (state === null) return null;

      const facts: ShipmentFacts = {
        trackingId,
        state,
        carrier: normalizeNullable(wire.transportista) ?? 'unknown',
        promisedAt: parseSgcDate(wire.promesa),
        lastEventAt: parseSgcDate(wire.ultimo_evento),
      };
      return facts;
    },

    async fetchHistory(customerDoc, evaluatedAt, tracer) {
      const movements = await readAllPages(session, customerDoc, tracer);
      if (movements === null) return null;

      const since = evaluatedAt.getTime() - HISTORY_WINDOW_DAYS * DAY_MS;
      let claims = 0;
      let orders = 0;
      let refunded: Cents = cents(0);

      for (const movement of movements) {
        const when = parseSgcDate(movement.fecha);
        // A movement without a readable date cannot be counted inside a time window.
        if (when === null || when.getTime() < since || when.getTime() > evaluatedAt.getTime()) {
          continue;
        }
        const kind = normalizeNullable(movement.tipo);
        if (kind === 'reclamo') claims += 1;
        if (kind === 'pedido') orders += 1;
        if (kind === 'reembolso') {
          refunded = addCents(refunded, parseSgcAmount(movement.monto) ?? cents(0));
        }
      }

      const facts: CustomerHistoryFacts = {
        customerDoc,
        claimsLast90Days: claims,
        refundedLast90Days: refunded,
        ordersLast90Days: orders,
      };
      return facts;
    },

    async fetchNotes(orderId, tracer) {
      const { body, status } = await session.get(
        'notes',
        '/sgc/notas',
        { pedido: orderId },
        jsonIsComplete,
        tracer,
      );
      if (status === 404) return [];

      const wire = JSON.parse(body) as WireNotes;
      return (wire.items ?? [])
        .map((item) => {
          const text = normalizeNullable(item.texto);
          if (text === null) return null;
          // The date is prefixed rather than dropped: a note written before the incident
          // means something different from one written after it, and the model has no
          // other way to tell. It is also the only place the epoch date format is
          // exercised end to end — this endpoint is the one that emits it.
          const at = parseSgcDate(item.fecha);
          return at === null ? text : `${at.toISOString()} — ${text}`;
        })
        .filter((note): note is string => note !== null);
    },
  };
}

/**
 * Pages the history to its real end.
 *
 * The stop condition is NOT the `total` SGC declares — it lies — nor the page count —
 * an out-of-range page hands back the first one. The stop is repetition: if a page
 * brings exactly what an earlier one brought, the ERP is looping and there is nothing
 * new. That is the only trustworthy signal it gives.
 *
 * If a later page fails, the error propagates and the whole history comes back `null`.
 * That is deliberate: a partial history undercounts claims, so a customer with five of
 * them can look clean. Half a history is more dangerous than none, because none is
 * declared as a missing fact and half is not.
 */
async function readAllPages(
  session: SgcSession,
  customerDoc: string,
  tracer: Tracer,
): Promise<readonly WireMovement[] | null> {
  const all: WireMovement[] = [];
  const seen = new Set<string>();

  for (let page = 1; page <= HISTORY_MAX_PAGES; page++) {
    const { body, status } = await session.get(
      'history',
      '/sgc/cliente/historial',
      { doc: customerDoc, pagina: String(page) },
      jsonIsComplete,
      tracer,
    );
    if (status === 404) return page === 1 ? null : all;

    const wire = JSON.parse(body) as WireHistoryPage;
    const items = wire.items ?? [];
    if (items.length === 0) break;

    const signature = JSON.stringify(items);
    if (seen.has(signature)) {
      tracer.mark('erp', 'history', `page ${page} repeated: the ERP is looping, stopping here`);
      break;
    }
    seen.add(signature);
    all.push(...items);

    const pageSize = Number(normalizeNullable(wire.por_pagina) ?? '0');
    // A short page is the last one. That is the other honest signal the ERP gives.
    if (pageSize > 0 && items.length < pageSize) break;
  }

  return all;
}

/** Extracts `<name>...</name>`. Works because this repo generates the XML and it is flat. */
function xmlField(body: string, name: string): string | null {
  const match = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(body);
  if (!match?.[1]) return null;
  return unescapeXml(match[1]);
}

const unescapeXml = (value: string): string =>
  value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&');
