import type { Game } from './types.ts';
import { expectedShareAtLeast, expectedShareBelow } from './expected.ts';

export type Tz = 'local' | 'utc';

/** Hour of day 0..23 for a timestamp, in the chosen timezone. */
export function hourOf(ms: number, tz: Tz): number {
  const d = new Date(ms);
  return tz === 'utc' ? d.getUTCHours() : d.getHours();
}

/** Calendar day key 'YYYY-MM-DD' for a timestamp, in the chosen timezone. */
export function dayKey(ms: number, tz: Tz): string {
  const d = new Date(ms);
  const y = tz === 'utc' ? d.getUTCFullYear() : d.getFullYear();
  const m = (tz === 'utc' ? d.getUTCMonth() : d.getMonth()) + 1;
  const day = tz === 'utc' ? d.getUTCDate() : d.getDate();
  return `${y}-${String(m).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/** Millisecond bounds of the calendar day containing `ms`, in the chosen timezone. */
export function dayBounds(ms: number, tz: Tz): { from: number; to: number } {
  const d = new Date(ms);
  if (tz === 'utc') {
    const from = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
    return { from, to: from + 86_400_000 };
  }
  const from = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const to = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime();
  return { from, to };
}

/** Parse a 'YYYY-MM-DD' key back into day bounds in the chosen timezone. */
export function dayBoundsFromKey(key: string, tz: Tz): { from: number; to: number } {
  const [y, m, d] = key.split('-').map(Number) as [number, number, number];
  if (tz === 'utc') {
    const from = Date.UTC(y, m - 1, d);
    return { from, to: from + 86_400_000 };
  }
  return {
    from: new Date(y, m - 1, d).getTime(),
    to: new Date(y, m - 1, d + 1).getTime(),
  };
}

export function hourLabel(hour: number): string {
  const hh = String(hour).padStart(2, '0');
  return `${hh}:00 - ${hh}:59`;
}

export interface HourBucket {
  hour: number;
  label: string;
  games: Game[];
}

/**
 * Group games into 24 hour-of-day buckets, always returning all 24 in order
 * so empty hours stay visible in the table.
 */
export function groupByHour(games: Game[], tz: Tz): HourBucket[] {
  const buckets: HourBucket[] = Array.from({ length: 24 }, (_, hour) => ({
    hour,
    label: hourLabel(hour),
    games: [],
  }));
  for (const game of games) {
    buckets[hourOf(game.endedAt, tz)]!.games.push(game);
  }
  for (const bucket of buckets) {
    bucket.games.sort((a, b) => a.endedAt - b.endedAt);
  }
  return buckets;
}

export function median(values: number[]): number {
  if (values.length === 0) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

export interface Summary {
  count: number;
  median: number;
  mean: number;
  max: number;
  /** Games that busted immediately at 1.00x. A fair game gives 1.98% of these. */
  instantBusts: number;
}

export function summary(busts: number[]): Summary {
  if (busts.length === 0) {
    return { count: 0, median: NaN, mean: NaN, max: NaN, instantBusts: 0 };
  }
  let sum = 0;
  let max = -Infinity;
  let instantBusts = 0;
  for (const b of busts) {
    sum += b;
    if (b > max) max = b;
    if (b <= 1) instantBusts++;
  }
  return { count: busts.length, median: median(busts), mean: sum / busts.length, max, instantBusts };
}

export const DEFAULT_THRESHOLDS = [1.1, 2, 5, 10, 100];

export interface ThresholdShare {
  threshold: number;
  below: number;
  atLeast: number;
  /** Observed fraction below the threshold, 0..1. */
  shareBelow: number;
  /** Fraction below expected from the provably-fair formula, 0..1. */
  expectedBelow: number;
  /** Observed minus expected, in fraction points. */
  delta: number;
}

/** Share of games under each threshold, next to what a fair game predicts. */
export function thresholdShares(
  busts: number[],
  thresholds: number[] = DEFAULT_THRESHOLDS,
): ThresholdShare[] {
  return thresholds.map((threshold) => {
    let below = 0;
    for (const b of busts) if (b < threshold) below++;
    const shareBelow = busts.length === 0 ? NaN : below / busts.length;
    const expectedBelow = expectedShareBelow(threshold);
    return {
      threshold,
      below,
      atLeast: busts.length - below,
      shareBelow,
      expectedBelow,
      delta: busts.length === 0 ? NaN : shareBelow - expectedBelow,
    };
  });
}

export const DEFAULT_HISTOGRAM_EDGES = [1, 1.1, 1.5, 2, 3, 5, 10, 20, 50, 100, Infinity];

export interface HistogramBin {
  /** Inclusive lower edge. */
  from: number;
  /** Exclusive upper edge. */
  to: number;
  label: string;
  count: number;
  share: number;
  /** Share of games a fair game puts in this bin. */
  expectedShare: number;
}

/** Bucket busts into log-scaled bins for the distribution chart. */
export function histogram(
  busts: number[],
  edges: number[] = DEFAULT_HISTOGRAM_EDGES,
): HistogramBin[] {
  const bins: HistogramBin[] = [];
  for (let i = 0; i < edges.length - 1; i++) {
    const from = edges[i]!;
    const to = edges[i + 1]!;
    bins.push({
      from,
      to,
      label: to === Infinity ? `${from}x+` : `${from}-${to}x`,
      count: 0,
      share: 0,
      expectedShare: expectedShareAtLeast(from) - expectedShareAtLeast(to),
    });
  }
  for (const b of busts) {
    for (let i = bins.length - 1; i >= 0; i--) {
      if (b >= bins[i]!.from) {
        bins[i]!.count++;
        break;
      }
    }
  }
  if (busts.length > 0) {
    for (const bin of bins) bin.share = bin.count / busts.length;
  }
  return bins;
}

export interface Run {
  length: number;
  /** Index of the first game in the run, -1 when there is no run. */
  startIndex: number;
  endIndex: number;
}

/** Longest consecutive stretch of games satisfying the predicate. */
export function longestRun(busts: number[], pred: (bust: number) => boolean): Run {
  let best: Run = { length: 0, startIndex: -1, endIndex: -1 };
  let current = 0;
  for (let i = 0; i < busts.length; i++) {
    if (pred(busts[i]!)) {
      current++;
      if (current > best.length) {
        best = { length: current, startIndex: i - current + 1, endIndex: i };
      }
    } else {
      current = 0;
    }
  }
  return best;
}

/**
 * Every stretch of at least `minLength` consecutive games satisfying the
 * predicate, in order. `longestRun` answers "what was the worst?"; this answers
 * "when did it happen, and how often?".
 */
export function findRuns(
  busts: number[],
  pred: (bust: number) => boolean,
  minLength = 2,
): Run[] {
  const runs: Run[] = [];
  let current = 0;
  for (let i = 0; i <= busts.length; i++) {
    if (i < busts.length && pred(busts[i]!)) {
      current++;
      continue;
    }
    if (current >= minLength) {
      runs.push({ length: current, startIndex: i - current, endIndex: i - 1 });
    }
    current = 0;
  }
  return runs;
}

/** Every stretch of at least `minLength` games that all busted below `threshold`. */
export function findLowRuns(busts: number[], threshold: number, minLength: number): Run[] {
  return findRuns(busts, (b) => b < threshold, minLength);
}

/** Longest stretch of games that all busted below the threshold. */
export function longestLowRun(busts: number[], threshold: number): Run {
  return longestRun(busts, (b) => b < threshold);
}

/** Longest stretch of games that all reached the threshold. */
export function longestHighRun(busts: number[], threshold: number): Run {
  return longestRun(busts, (b) => b >= threshold);
}

export interface SinceLast {
  /** Games played after the most recent hit. */
  games: number;
  /** Milliseconds since that hit ended. */
  ms: number;
  /** The hit itself. */
  game: Game;
}

/**
 * How long it has been since a game reached the threshold.
 * Input must be sorted ascending by endedAt. Returns null when no hit exists.
 */
export function gamesSinceLast(games: Game[], threshold: number, now?: number): SinceLast | null {
  for (let i = games.length - 1; i >= 0; i--) {
    const game = games[i]!;
    if (game.bust >= threshold) {
      const reference = now ?? games[games.length - 1]!.endedAt;
      return { games: games.length - 1 - i, ms: reference - game.endedAt, game };
    }
  }
  return null;
}

/** Games elapsed between successive hits of the threshold, for streak analysis. */
export function gapsBetweenHits(games: Game[], threshold: number): number[] {
  const gaps: number[] = [];
  let last = -1;
  for (let i = 0; i < games.length; i++) {
    if (games[i]!.bust >= threshold) {
      if (last >= 0) gaps.push(i - last - 1);
      last = i;
    }
  }
  return gaps;
}

export interface StreakReport {
  threshold: number;
  longestLow: Run;
  longestHigh: Run;
  sinceLastHigh: SinceLast | null;
  /** Gaps between hits of the high threshold. */
  gaps: number[];
  medianGap: number;
  maxGap: number;
  /** Expected gap for a fair game: 1 / P(bust >= threshold). */
  expectedGap: number;
}

/** Everything the streak panel shows, computed in one pass over the window. */
export function streakReport(games: Game[], lowThreshold = 2, highThreshold = 10): StreakReport {
  const busts = games.map((g) => g.bust);
  const gaps = gapsBetweenHits(games, highThreshold);
  return {
    threshold: highThreshold,
    longestLow: longestLowRun(busts, lowThreshold),
    longestHigh: longestHighRun(busts, lowThreshold),
    sinceLastHigh: gamesSinceLast(games, highThreshold),
    gaps,
    medianGap: median(gaps),
    maxGap: gaps.length > 0 ? Math.max(...gaps) : NaN,
    expectedGap: 1 / expectedShareAtLeast(highThreshold),
  };
}

export interface HourStat {
  hour: number;
  label: string;
  count: number;
  median: number;
  mean: number;
  max: number;
  /** Fraction of the hour's games below the low threshold, 0..1. */
  shareBelow: number;
}

/** Per-hour summary row for the hourly chart and table. */
export function hourlyStats(buckets: HourBucket[], lowThreshold = 2): HourStat[] {
  return buckets.map((bucket) => {
    const busts = bucket.games.map((g) => g.bust);
    const s = summary(busts);
    const below = busts.filter((b) => b < lowThreshold).length;
    return {
      hour: bucket.hour,
      label: bucket.label,
      count: s.count,
      median: s.median,
      mean: s.mean,
      max: s.max,
      shareBelow: s.count === 0 ? NaN : below / s.count,
    };
  });
}

export function formatBust(bust: number): string {
  return Number.isFinite(bust) ? `${bust.toFixed(2)}x` : '—';
}

export function formatPercent(fraction: number, digits = 1): string {
  return Number.isFinite(fraction) ? `${(fraction * 100).toFixed(digits)}%` : '—';
}

export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '—';
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

export function formatClock(ms: number, tz: Tz): string {
  const d = new Date(ms);
  const hh = tz === 'utc' ? d.getUTCHours() : d.getHours();
  const mm = tz === 'utc' ? d.getUTCMinutes() : d.getMinutes();
  const ss = tz === 'utc' ? d.getUTCSeconds() : d.getSeconds();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(hh)}:${p(mm)}:${p(ss)}`;
}
