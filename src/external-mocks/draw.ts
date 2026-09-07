/**
 * The single source of randomness in the whole simulator.
 *
 * Nothing calls `Math.random()` directly: the ERP's probabilistic hostilities ask here
 * for a number. Production passes `systemDraw`; tests and evals pass `seededDraw(n)`,
 * and the same seed gives the same run. That is what makes it possible to test "the ERP
 * returns 429" without patching a global or writing a test that fails one day in twenty.
 *
 * The draw is KEYED, and that is the part that took a broken run to learn. It used to be
 * a sequence — every call pulled the next number — and the ERP is read concurrently: the
 * shipment, the history and the notes go out together. The order they arrive in is
 * deterministic, but the order they RESUME in after a simulated latency or a retry
 * backoff is not, because those wait on real timers. So the same trial could draw its
 * numbers in a different order on a slower machine, and a different read would be the
 * one that ran out of attempts.
 *
 * It surfaced when a recorded eval run and its replay starved different trials, which
 * left a cassette missing. Keyed by the request instead of by position, concurrency
 * cannot change what any single request gets.
 */
export type Draw = (key: string) => number;

/** Production. The key is ignored: real randomness has nothing to be stable about. */
export const systemDraw: Draw = () => Math.random();

/**
 * Deterministic per key. mulberry32 over a hash of `(seed, key)` — 32 bits of state,
 * good distribution, zero dependencies.
 */
export function seededDraw(seed: number): Draw {
  return (key: string) => {
    // FNV-1a folds the key into the seed, so two different requests of one trial get
    // unrelated numbers while the same request always gets its own.
    let state = seed >>> 0;
    for (let i = 0; i < key.length; i++) {
      state = Math.imul(state ^ key.charCodeAt(i), 16_777_619) >>> 0;
    }

    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/** A `Draw` that always returns the same value, to pin one hostility in a test. */
export const constantDraw = (value: number): Draw => () => value;
