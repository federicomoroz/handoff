import { DAY_MS } from '../domain/time';

/**
 * SGC's internal state.
 *
 * It deliberately does NOT use domain types: amounts are strings with a decimal comma
 * and states are ambiguous numbers, exactly as they would arrive over HTTP from a real
 * legacy ERP. If the seed used `Cents` and `ShipmentState`, the simulator would be
 * lying about how hard the problem is and the adapter would have nothing to solve.
 *
 * Field names stay in SGC's own Spanish vocabulary on purpose — they are the foreign
 * system's wire format, not our identifiers, and translating them would erase the very
 * thing this project demonstrates. The values are the data of a simulated Argentine
 * operation, which is why customer notes are in Spanish too.
 *
 * Nothing in this file appears in the prompts or the eval cases: the model reaches this
 * data through the tools and by no other path.
 */

export interface SeedOrder {
  readonly nro: string;
  readonly tipo_doc: 'FC' | 'NC';
  /** Argentine format, exactly as the ERP emits it. */
  readonly total: string;
  readonly fecha: Date;
  readonly cliente_doc: string;
  readonly guia: string | null;
}

export interface SeedShipment {
  readonly guia: string;
  /** The number whose meaning depends on `tipo_doc`, which lives in the OTHER endpoint. */
  readonly estado: number;
  readonly transportista: string;
  readonly promesa: Date | null;
  readonly ultimo_evento: Date | null;
}

export type MovementType = 'pedido' | 'reclamo' | 'reembolso';

/**
 * One history line. SGC does NOT return counters: it returns paged movements and the
 * adapter is the one that sums. That is on purpose — with pre-computed counters the
 * lying pagination would cost nobody anything, and the aggregation, which has exactly
 * one correct answer, would stop being the code's job.
 */
export interface SeedMovement {
  readonly tipo: MovementType;
  readonly fecha: Date;
  readonly monto: string;
}

export interface SeedCustomer {
  readonly doc: string;
  readonly movimientos: readonly SeedMovement[];
}

export interface SeedNote {
  readonly pedido: string;
  readonly texto: string;
  readonly fecha: Date;
}

export interface ErpSeed {
  readonly orders: Record<string, SeedOrder>;
  readonly shipments: Record<string, SeedShipment>;
  readonly customers: Record<string, SeedCustomer>;
  readonly notes: readonly SeedNote[];
}

const d = (iso: string): Date => new Date(iso);

/** Anchor for generated movements. The whole seed lives around late August 2026. */
const HISTORY_ANCHOR = d('2026-08-30T12:00:00Z');

/**
 * Builds a deterministic history: `orders` and `claims` inside the last 90 days, and
 * `stale` movements outside the window. The stale ones exist so the adapter has to
 * filter by date instead of just counting rows.
 */
function movements(orders: number, claims: number, stale: number): readonly SeedMovement[] {
  const out: SeedMovement[] = [];
  for (let i = 0; i < orders; i++) {
    out.push({
      tipo: 'pedido',
      fecha: new Date(HISTORY_ANCHOR.getTime() - (i * 4 + 1) * DAY_MS),
      monto: '12.000,00',
    });
  }
  for (let i = 0; i < claims; i++) {
    out.push({
      tipo: 'reclamo',
      fecha: new Date(HISTORY_ANCHOR.getTime() - (i * 11 + 3) * DAY_MS),
      monto: '0,00',
    });
    out.push({
      tipo: 'reembolso',
      fecha: new Date(HISTORY_ANCHOR.getTime() - (i * 11 + 2) * DAY_MS),
      monto: '17.600,00',
    });
  }
  for (let i = 0; i < stale; i++) {
    out.push({
      tipo: 'reclamo',
      fecha: new Date(HISTORY_ANCHOR.getTime() - (120 + i * 15) * DAY_MS),
      monto: '0,00',
    });
  }
  return out.sort((a, b) => b.fecha.getTime() - a.fecha.getTime());
}

export const BASE_SEED: ErpSeed = {
  orders: {
    // Healthy case: delivered, clean customer, small amount. Acting is allowed.
    'FC-10241': {
      nro: 'FC-10241',
      tipo_doc: 'FC',
      total: '48.290,00',
      fecha: d('2026-08-20T12:00:00Z'),
      cliente_doc: '20304050',
      guia: 'OCA-889',
    },
    // In transit: cannot be refunded yet.
    'FC-10242': {
      nro: 'FC-10242',
      tipo_doc: 'FC',
      total: '15.375,50',
      fecha: d('2026-08-26T09:30:00Z'),
      cliente_doc: '20304050',
      guia: 'AND-441',
    },
    // Credit note: state 3 here means cancelled, not delivered.
    'NC-10243': {
      nro: 'NC-10243',
      tipo_doc: 'NC',
      total: '98.000,00',
      fecha: d('2026-08-18T16:45:00Z'),
      cliente_doc: '33999888',
      guia: 'OCA-902',
    },
    // Above the value threshold: always a human.
    'FC-10244': {
      nro: 'FC-10244',
      tipo_doc: 'FC',
      total: '612.400,00',
      fecha: d('2026-08-22T11:00:00Z'),
      cliente_doc: '20304050',
      guia: 'OCA-915',
    },
    // Customer with five claims in 90 days.
    'FC-10245': {
      nro: 'FC-10245',
      tipo_doc: 'FC',
      total: '22.000,00',
      fecha: d('2026-08-24T14:20:00Z'),
      cliente_doc: '27111222',
      guia: 'AND-460',
    },
    // The shipment does not exist in the ERP: an explicit missing fact, not silence.
    'FC-10246': {
      nro: 'FC-10246',
      tipo_doc: 'FC',
      total: '45.800,00',
      fecha: d('2026-08-27T10:10:00Z'),
      cliente_doc: '33999888',
      guia: 'OCA-999',
    },
    // No tracking id at all. Exercises hostility 5 on the XML side: the simulator has
    // to render "no value" in one of its four shapes, and the parser has to read all
    // four back as the same null. Without an order like this one, `renderNull` is never
    // called and the hostility is declared but never happens.
    'FC-10248': {
      nro: 'FC-10248',
      tipo_doc: 'FC',
      total: '31.500,00',
      fecha: d('2026-08-28T09:15:00Z'),
      cliente_doc: '33999888',
      guia: null,
    },
    // A shipment the carrier never gave dates for: hostility 5 on the JSON side.
    'FC-10249': {
      nro: 'FC-10249',
      tipo_doc: 'FC',
      total: '19.900,00',
      fecha: d('2026-08-29T11:40:00Z'),
      cliente_doc: '20304050',
      guia: 'AND-475',
    },
    // No news for ten days: stale data for anything irreversible.
    'FC-10247': {
      nro: 'FC-10247',
      tipo_doc: 'FC',
      total: '8.900,00',
      fecha: d('2026-08-05T08:00:00Z'),
      cliente_doc: '20304050',
      guia: 'OCA-930',
    },
  },

  shipments: {
    'OCA-889': {
      guia: 'OCA-889',
      estado: 3,
      transportista: 'OCA',
      promesa: d('2026-08-28T12:00:00Z'),
      ultimo_evento: d('2026-08-29T12:00:00Z'),
    },
    'AND-441': {
      guia: 'AND-441',
      estado: 1,
      transportista: 'Andreani',
      promesa: d('2026-09-02T12:00:00Z'),
      ultimo_evento: d('2026-08-29T18:00:00Z'),
    },
    'OCA-902': {
      guia: 'OCA-902',
      estado: 3,
      transportista: 'OCA',
      promesa: d('2026-08-25T12:00:00Z'),
      ultimo_evento: d('2026-08-28T09:00:00Z'),
    },
    'OCA-915': {
      guia: 'OCA-915',
      estado: 3,
      transportista: 'OCA',
      promesa: d('2026-08-27T12:00:00Z'),
      ultimo_evento: d('2026-08-29T15:30:00Z'),
    },
    'AND-460': {
      guia: 'AND-460',
      estado: 5,
      transportista: 'Andreani',
      promesa: d('2026-08-29T12:00:00Z'),
      ultimo_evento: d('2026-08-29T20:00:00Z'),
    },
    'AND-475': {
      guia: 'AND-475',
      estado: 1,
      transportista: 'Andreani',
      promesa: null,
      ultimo_evento: null,
    },
    'OCA-930': {
      guia: 'OCA-930',
      estado: 3,
      transportista: 'OCA',
      promesa: d('2026-08-12T12:00:00Z'),
      ultimo_evento: d('2026-08-19T10:00:00Z'),
    },
  },

  customers: {
    // Clean customer: four orders, no claims.
    '20304050': { doc: '20304050', movimientos: movements(4, 0, 0) },
    // Five claims in 90 days, and 30 movements: more than one page, so the lying
    // pagination has something to lie about.
    '27111222': { doc: '27111222', movimientos: movements(17, 5, 3) },
    '33999888': { doc: '33999888', movimientos: movements(3, 1, 0) },
  },

  notes: [
    {
      pedido: 'FC-10241',
      texto: 'Cliente avisa por telefono que la caja llego mojada.',
      fecha: d('2026-08-30T13:40:00Z'),
    },
    {
      pedido: 'FC-10245',
      texto: 'Tercer reclamo del mes por el mismo domicilio.',
      fecha: d('2026-08-29T17:05:00Z'),
    },
  ],
};

/**
 * Deep copy of the seed. Every eval trial and every test builds its own, so one case's
 * state never leaks into the next, not even running in parallel.
 */
export const cloneSeed = (seed: ErpSeed = BASE_SEED): ErpSeed => structuredClone(seed);
