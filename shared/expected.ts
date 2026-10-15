/**
 * Fair-RNG reference values for bustabit's current formula.
 *
 * bust = max(1, floor(99 / (1 - X)) / 100) with X uniform on [0, 1).
 * So P(bust >= t) = 0.99 / t for t >= 1. These are the numbers observed data is
 * compared against: the game is provably random, so deviations are sampling noise.
 *
 * Note the clamp is not the whole story for instant busts. A result shows as
 * 1.00x whenever floor(99 / (1 - X)) is 100 or less, which is X < 2/101, so
 * 1.98% of games display 1.00x even though only 1% are clamped from below.
 */

/** The house edge encoded in the formula: 99 means 1%. */
export const HOUSE_EDGE_NUMERATOR = 0.99;

/** Probability a game reaches at least `t`. */
export function expectedShareAtLeast(t: number): number {
  if (t <= 1) return 1;
  return HOUSE_EDGE_NUMERATOR / t;
}

/** Probability a game busts below `t`. */
export function expectedShareBelow(t: number): number {
  return 1 - expectedShareAtLeast(t);
}

/** Expected number of games between two results of at least `t`. */
export function expectedGapAtLeast(t: number): number {
  return 1 / expectedShareAtLeast(t);
}

/** Median bust of a fair game: 0.99 / 0.5 = 1.98x. */
export const FAIR_MEDIAN = 1.98;

/** Share of games that display 1.00x: 1 - 0.99 / 1.01. */
export const EXPECTED_INSTANT_BUST_SHARE = 1 - HOUSE_EDGE_NUMERATOR / 1.01;

/** Lowest possible result. Anything under this is a decode bug, not a game. */
export const MIN_BUST = 1;
