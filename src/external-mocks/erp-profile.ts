/**
 * SGC's ten hostilities, as DATA.
 *
 * None of them is written as code in the handlers: the simulator has one function that
 * serves, and this profile tells it how to misbehave. Same pattern as
 * `CarrierSimulationProfile` in shipping-quote, and it is what lets the SAME contract
 * suite run against a hostile ERP and a tame one without a single `if` per profile —
 * the shared code asks, the profile answers.
 */

/** Which format each endpoint uses for dates. Hostility 8: all three coexist. */
export type DateFormat = 'dmy' | 'iso' | 'epoch';

export interface ErpProfile {
  readonly name: string;

  /** Hostility 10: latency with jitter, in ms. */
  readonly latencyMs: readonly [number, number];

  /** Hostility 2: calls a token survives before returning 401. `0` means it never expires. */
  readonly sessionMaxCalls: number;

  /** Hostility 3: probability of a 429 per request. */
  readonly rateLimitProbability: number;
  readonly retryAfterSeconds: number;
  /** When throttling, whether `Retry-After` is an HTTP date instead of seconds. */
  readonly retryAfterAsHttpDate: boolean;

  /** Hostility 4: probability of returning 200 with a truncated body. */
  readonly truncationProbability: number;

  /**
   * Hostility 5: the shapes of "no value" this profile rotates through.
   * `undefined` means the key is simply absent — `JSON.stringify` drops it, which is
   * exactly what an ERP that does not serialise nulls does.
   */
  readonly nullStyles: readonly (string | null | undefined)[];

  /** Hostility 7: page size, and whether the declared `total` is a lie. */
  readonly pageSize: number;
  readonly lyingTotal: boolean;
  /** Whether an out-of-range page returns the first one instead of an empty one. */
  readonly wrapsAroundPages: boolean;

  readonly dateFormats: Readonly<Record<'order' | 'shipment' | 'notes', DateFormat>>;
}

/**
 * The ERP as it really behaves. The numbers are not arbitrary: 15% 429s and 8%
 * truncation are enough to break a naive adapter over a 36-case run, and low enough
 * that a correct one does not take forever.
 */
export const SGC_HOSTILE: ErpProfile = {
  name: 'sgc_hostile',
  latencyMs: [15, 90],
  sessionMaxCalls: 4,
  rateLimitProbability: 0.15,
  retryAfterSeconds: 1,
  retryAfterAsHttpDate: true,
  truncationProbability: 0.08,
  nullStyles: [null, '', 'N/A', '-', undefined],
  pageSize: 20,
  lyingTotal: true,
  wrapsAroundPages: true,
  dateFormats: { order: 'dmy', shipment: 'iso', notes: 'epoch' },
};

/**
 * The same ERP with every hostility switched off.
 *
 * It does not exist to make tests easy: it exists so the contract suite can run against
 * both and prove the adapter produces the SAME result. If a case passed on `tame` and
 * failed on `hostile`, the hostility is not resolved; if a case ever needed an `if` per
 * profile, that would be the signal the abstraction broke.
 */
export const SGC_TAME: ErpProfile = {
  name: 'sgc_tame',
  latencyMs: [0, 0],
  sessionMaxCalls: 0,
  rateLimitProbability: 0,
  retryAfterSeconds: 0,
  retryAfterAsHttpDate: false,
  truncationProbability: 0,
  nullStyles: [null],
  pageSize: 20,
  lyingTotal: false,
  wrapsAroundPages: false,
  dateFormats: { order: 'dmy', shipment: 'iso', notes: 'epoch' },
};
