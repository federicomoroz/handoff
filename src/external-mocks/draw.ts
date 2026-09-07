/**
 * The single source of randomness in the whole simulator.
 *
 * Nothing calls `Math.random()` directly: the ERP's probabilistic hostilities ask here
 * for a number. Production passes `Math.random`; tests pass `seededDraw(n)`, and the
 * same seed gives the same run. That is what makes it possible to test "the ERP returns
 * 429" without patching a global or writing a test that fails one day in twenty.
 */
export type Draw = () => number;

export const systemDraw: Draw = Math.random;

/** mulberry32: 32 bits of state, good distribution, zero dependencies. */
export function seededDraw(seed: number): Draw {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/** A `Draw` that always returns the same value, to pin one hostility in a test. */
export const constantDraw = (value: number): Draw => () => value;
