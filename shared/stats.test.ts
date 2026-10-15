import { describe, expect, it } from 'vitest';
import type { Game } from './types.ts';
import {
  dayBounds,
  dayBoundsFromKey,
  dayKey,
  formatBust,
  formatDuration,
  formatPercent,
  findLowRuns,
  gamesSinceLast,
  gapsBetweenHits,
  groupByHour,
  histogram,
  hourLabel,
  hourOf,
  hourlyStats,
  longestHighRun,
  longestLowRun,
  median,
  streakReport,
  summary,
  thresholdShares,
} from './stats.ts';
import { expectedShareAtLeast, expectedShareBelow, FAIR_MEDIAN } from './expected.ts';

/** Build a game at a fixed UTC instant so tests are timezone independent. */
function game(bust: number, utc: number, id: number | null = null): Game {
  return { id, bust, hash: 'f'.repeat(64), endedAt: utc, tsSource: 'live' };
}

const HOUR = 3_600_000;
const DAY = 86_400_000;
/** 2026-09-10T00:00:00Z */
const BASE = Date.UTC(2026, 8, 10);

describe('hourOf / dayKey', () => {
  it('reads the hour in UTC', () => {
    expect(hourOf(BASE, 'utc')).toBe(0);
    expect(hourOf(BASE + 13 * HOUR, 'utc')).toBe(13);
    expect(hourOf(BASE + 23 * HOUR + 3_599_999, 'utc')).toBe(23);
  });

  it('agrees with the platform Date for local time', () => {
    const ms = BASE + 7 * HOUR + 42 * 60_000;
    expect(hourOf(ms, 'local')).toBe(new Date(ms).getHours());
    expect(dayKey(ms, 'local')).toBe(
      `${new Date(ms).getFullYear()}-${String(new Date(ms).getMonth() + 1).padStart(2, '0')}-${String(
        new Date(ms).getDate(),
      ).padStart(2, '0')}`,
    );
  });

  it('formats UTC day keys', () => {
    expect(dayKey(BASE, 'utc')).toBe('2026-09-10');
    expect(dayKey(BASE + DAY - 1, 'utc')).toBe('2026-09-10');
    expect(dayKey(BASE + DAY, 'utc')).toBe('2026-09-11');
  });

  it('labels hours in the README format', () => {
    expect(hourLabel(0)).toBe('00:00 - 00:59');
    expect(hourLabel(23)).toBe('23:00 - 23:59');
  });
});

describe('dayBounds', () => {
  it('spans exactly one UTC day', () => {
    const { from, to } = dayBounds(BASE + 15 * HOUR, 'utc');
    expect(from).toBe(BASE);
    expect(to - from).toBe(DAY);
  });

  it('round-trips through a day key in both zones', () => {
    for (const tz of ['utc', 'local'] as const) {
      const ms = BASE + 15 * HOUR;
      const bounds = dayBounds(ms, tz);
      expect(dayBoundsFromKey(dayKey(ms, tz), tz)).toEqual(bounds);
      expect(ms).toBeGreaterThanOrEqual(bounds.from);
      expect(ms).toBeLessThan(bounds.to);
    }
  });

  it('covers a local day even across a DST shift', () => {
    // Late March and late October contain the EU/US transitions.
    for (const start of [Date.UTC(2026, 2, 29), Date.UTC(2026, 9, 25)]) {
      const { from, to } = dayBounds(start + 12 * HOUR, 'local');
      const span = to - from;
      expect(span).toBeGreaterThanOrEqual(23 * HOUR);
      expect(span).toBeLessThanOrEqual(25 * HOUR);
    }
  });
});

describe('groupByHour', () => {
  it('always returns 24 ordered buckets, empty ones included', () => {
    const buckets = groupByHour([game(2, BASE + 5 * HOUR)], 'utc');
    expect(buckets).toHaveLength(24);
    expect(buckets.map((b) => b.hour)).toEqual([...Array(24).keys()]);
    expect(buckets[5]!.games).toHaveLength(1);
    expect(buckets[4]!.games).toHaveLength(0);
  });

  it('puts 23:59 and 00:00 in different buckets', () => {
    const buckets = groupByHour(
      [game(1.5, BASE + 23 * HOUR + 59 * 60_000), game(3, BASE + DAY)],
      'utc',
    );
    expect(buckets[23]!.games).toHaveLength(1);
    expect(buckets[0]!.games).toHaveLength(1);
  });

  it('sorts each bucket chronologically regardless of input order', () => {
    const buckets = groupByHour(
      [game(3, BASE + 30 * 60_000), game(2, BASE + 10 * 60_000), game(4, BASE + 50 * 60_000)],
      'utc',
    );
    expect(buckets[0]!.games.map((g) => g.bust)).toEqual([2, 3, 4]);
  });
});

describe('median / summary', () => {
  it('takes the middle of an odd list and the midpoint of an even one', () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(2.5);
    expect(median([])).toBeNaN();
  });

  it('summarises a window and counts instant busts', () => {
    const s = summary([1, 1, 2, 4, 10]);
    expect(s.count).toBe(5);
    expect(s.median).toBe(2);
    expect(s.mean).toBeCloseTo(3.6, 10);
    expect(s.max).toBe(10);
    expect(s.instantBusts).toBe(2);
  });

  it('returns an empty summary rather than throwing on no data', () => {
    const s = summary([]);
    expect(s.count).toBe(0);
    expect(s.median).toBeNaN();
    expect(s.instantBusts).toBe(0);
  });
});

describe('thresholdShares', () => {
  const busts = [1, 1.05, 1.5, 2, 2.5, 5, 9, 10, 40, 120];

  it('counts strictly below the threshold', () => {
    const [t2] = thresholdShares(busts, [2]);
    expect(t2!.below).toBe(3);
    expect(t2!.atLeast).toBe(7);
    expect(t2!.shareBelow).toBeCloseTo(0.3, 10);
  });

  it('compares against the provably-fair expectation', () => {
    const [t2] = thresholdShares(busts, [2]);
    expect(t2!.expectedBelow).toBeCloseTo(1 - 0.99 / 2, 10);
    expect(t2!.delta).toBeCloseTo(t2!.shareBelow - t2!.expectedBelow, 10);
  });

  it('is monotonic in the threshold', () => {
    const shares = thresholdShares(busts, [1.1, 2, 5, 10, 100]);
    for (let i = 1; i < shares.length; i++) {
      expect(shares[i]!.below).toBeGreaterThanOrEqual(shares[i - 1]!.below);
      expect(shares[i]!.expectedBelow).toBeGreaterThanOrEqual(shares[i - 1]!.expectedBelow);
    }
  });

  it('reports NaN shares instead of dividing by zero', () => {
    const [t] = thresholdShares([], [2]);
    expect(t!.below).toBe(0);
    expect(t!.shareBelow).toBeNaN();
    expect(t!.delta).toBeNaN();
  });
});

describe('histogram', () => {
  it('assigns each bust to the bin containing it', () => {
    const bins = histogram([1, 1.09, 1.1, 1.99, 2, 250], [1, 1.1, 2, Infinity]);
    expect(bins.map((b) => b.count)).toEqual([2, 2, 2]);
    expect(bins.at(-1)!.label).toBe('2x+');
  });

  it('produces shares summing to one and expectations summing to one', () => {
    const bins = histogram([1, 1.5, 3, 12, 300]);
    const share = bins.reduce((a, b) => a + b.share, 0);
    const expected = bins.reduce((a, b) => a + b.expectedShare, 0);
    expect(share).toBeCloseTo(1, 10);
    expect(expected).toBeCloseTo(1, 10);
  });

  it('counts nothing and keeps bins on empty input', () => {
    const bins = histogram([]);
    expect(bins.every((b) => b.count === 0 && b.share === 0)).toBe(true);
    expect(bins.length).toBeGreaterThan(0);
  });
});

describe('runs and gaps', () => {
  const busts = [1, 1.2, 1.5, 3, 1.1, 1.1, 1.1, 1.4, 8, 20];

  it('finds the longest low run and where it starts', () => {
    const run = longestLowRun(busts, 2);
    expect(run.length).toBe(4);
    expect(run.startIndex).toBe(4);
    expect(run.endIndex).toBe(7);
  });

  it('finds the longest high run', () => {
    expect(longestHighRun(busts, 2).length).toBe(2);
  });

  it('returns an empty run when nothing qualifies', () => {
    expect(longestLowRun([5, 6, 7], 2)).toEqual({ length: 0, startIndex: -1, endIndex: -1 });
  });

  it('counts games between hits, excluding the hits themselves', () => {
    const games = [10, 1, 1, 12, 2, 15].map((b, i) => game(b, BASE + i * 20_000));
    expect(gapsBetweenHits(games, 10)).toEqual([2, 1]);
  });
});

describe('gamesSinceLast', () => {
  const games = [12, 1.2, 1.5, 30, 1.1, 2].map((b, i) => game(b, BASE + i * 20_000));

  it('measures games and time since the most recent hit', () => {
    const since = gamesSinceLast(games, 10)!;
    expect(since.game.bust).toBe(30);
    expect(since.games).toBe(2);
    expect(since.ms).toBe(2 * 20_000);
  });

  it('measures against an explicit now when given', () => {
    const since = gamesSinceLast(games, 10, BASE + 100_000)!;
    expect(since.ms).toBe(100_000 - 3 * 20_000);
  });

  it('returns null when nothing ever hit', () => {
    expect(gamesSinceLast(games, 1000)).toBeNull();
  });
});

describe('streakReport', () => {
  it('bundles the streak panel numbers', () => {
    const games = [1, 1.1, 1.5, 12, 1.2, 1.3, 1.4, 1.5, 25].map((b, i) =>
      game(b, BASE + i * 20_000),
    );
    const report = streakReport(games, 2, 10);
    expect(report.longestLow.length).toBe(4);
    expect(report.sinceLastHigh!.games).toBe(0);
    expect(report.gaps).toEqual([4]);
    expect(report.expectedGap).toBeCloseTo(1 / 0.099, 6);
  });
});

describe('hourlyStats', () => {
  it('summarises each hour and marks empty hours as NaN', () => {
    const games = [
      game(1.5, BASE + 10 * 60_000),
      game(4, BASE + 20 * 60_000),
      game(3, BASE + HOUR + 5 * 60_000),
    ];
    const stats = hourlyStats(groupByHour(games, 'utc'), 2);
    expect(stats[0]!.count).toBe(2);
    expect(stats[0]!.median).toBe(2.75);
    expect(stats[0]!.shareBelow).toBeCloseTo(0.5, 10);
    expect(stats[1]!.count).toBe(1);
    expect(stats[2]!.count).toBe(0);
    expect(stats[2]!.shareBelow).toBeNaN();
  });
});

describe('expected values', () => {
  it('matches the 1% house edge', () => {
    expect(expectedShareAtLeast(2)).toBeCloseTo(0.495, 10);
    expect(expectedShareAtLeast(10)).toBeCloseTo(0.099, 10);
    expect(expectedShareBelow(1)).toBeCloseTo(0, 10);
    expect(expectedShareAtLeast(1)).toBe(1);
  });

  it('puts the fair median just under 2x', () => {
    expect(expectedShareAtLeast(FAIR_MEDIAN)).toBeCloseTo(0.5, 10);
  });
});

describe('formatting', () => {
  it('renders busts, percentages and durations', () => {
    expect(formatBust(1)).toBe('1.00x');
    expect(formatBust(12.345)).toBe('12.35x');
    expect(formatBust(NaN)).toBe('—');
    expect(formatPercent(0.4952, 1)).toBe('49.5%');
    expect(formatPercent(NaN)).toBe('—');
    expect(formatDuration(45_000)).toBe('45s');
    expect(formatDuration(125_000)).toBe('2m 5s');
    expect(formatDuration(3 * HOUR + 20 * 60_000)).toBe('3h 20m');
    expect(formatDuration(50 * HOUR)).toBe('2d 2h');
    expect(formatDuration(-1)).toBe('—');
  });
});

describe('findRuns', () => {
  const busts = [1.2, 1.5, 3, 1.1, 1.1, 1.1, 1.4, 8, 1.9, 1.2, 1.3, 20];

  it('finds every qualifying stretch in order', () => {
    const runs = findLowRuns(busts, 2, 3);
    expect(runs).toHaveLength(2);
    expect(runs[0]).toEqual({ length: 4, startIndex: 3, endIndex: 6 });
    expect(runs[1]).toEqual({ length: 3, startIndex: 8, endIndex: 10 });
  });

  it('honours the minimum length', () => {
    expect(findLowRuns(busts, 2, 2)).toHaveLength(3);
    expect(findLowRuns(busts, 2, 5)).toHaveLength(0);
  });

  it('includes a run that reaches the end of the data', () => {
    const runs = findLowRuns([5, 1.1, 1.2, 1.3], 2, 3);
    expect(runs).toEqual([{ length: 3, startIndex: 1, endIndex: 3 }]);
  });

  it('includes a run that starts at the beginning', () => {
    const runs = findLowRuns([1.1, 1.2, 1.3, 5], 2, 3);
    expect(runs).toEqual([{ length: 3, startIndex: 0, endIndex: 2 }]);
  });

  it('agrees with longestRun on the worst stretch', () => {
    const runs = findLowRuns(busts, 2, 1);
    const longest = Math.max(...runs.map((r) => r.length));
    expect(longest).toBe(longestLowRun(busts, 2).length);
  });

  it('returns nothing when nothing qualifies', () => {
    expect(findLowRuns([5, 6, 7], 2, 2)).toEqual([]);
    expect(findLowRuns([], 2, 2)).toEqual([]);
  });

  it('treats the threshold as strict', () => {
    // Exactly 2.00x is not "under 2x" and breaks the run.
    expect(findLowRuns([1.5, 2, 1.5], 2, 2)).toEqual([]);
  });
});
