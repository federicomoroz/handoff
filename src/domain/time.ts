/**
 * Time constants shared across layers.
 *
 * They live in the domain because everyone may import the domain, and because an hour
 * is not a detail of any adapter. Previously `HOUR_MS` and `DAY_MS` were written out
 * three times in three files — the kind of duplication that stays correct until the day
 * one copy is edited.
 */
export const HOUR_MS = 3_600_000;
export const DAY_MS = 86_400_000;

/**
 * Argentina has had no daylight saving since 2009: a fixed offset.
 *
 * It is one half of a wire contract — the simulated ERP emits local time and the wire
 * parser reads it back — so the two sides must never hold their own copy. It lives here
 * rather than in either of them because a timezone belongs to neither the simulator nor
 * the adapter, and because putting it in the adapter made the simulator import the very
 * code that is supposed to be reading it from the outside.
 */
export const ART_OFFSET_HOURS = -3;
