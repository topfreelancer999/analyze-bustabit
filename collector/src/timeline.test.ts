import { describe, expect, it } from 'vitest';
import { placeGamesInTime, type PlaceableGame } from './timeline.ts';

const T0 = Date.UTC(2026, 8, 10, 6, 0, 0);
const HOUR = 3_600_000;

/** A run of games, all 2x so each is expected to take the same time. */
function games(count: number, bust = 2): PlaceableGame[] {
  return Array.from({ length: count }, (_, i) => ({
    id: 13_500_000 + i,
    hash: String(i).padStart(64, '0'),
    bust,
  }));
}

describe('placeGamesInTime', () => {
  it('marks anchored games as measured and the rest as worked out', () => {
    const list = games(5);
    const rows = placeGamesInTime(list, new Map([[0, T0], [4, T0 + 4 * 18_000]]));
    const byId = new Map(rows.map((r) => [r.id, r]));
    expect(byId.get(list[0]!.id)!.tsSource).toBe('rpc');
    expect(byId.get(list[4]!.id)!.tsSource).toBe('rpc');
    expect(byId.get(list[2]!.id)!.tsSource).toBe('interp');
  });

  it('places every game exactly once', () => {
    const list = games(50);
    const rows = placeGamesInTime(list, new Map([[0, T0], [25, T0 + HOUR], [50, T0 + 2 * HOUR]]));
    expect(rows).toHaveLength(50);
    expect(new Set(rows.map((r) => r.id)).size).toBe(50);
  });

  it('keeps games in chronological order', () => {
    const list = games(40, 3);
    const rows = placeGamesInTime(list, new Map([[0, T0], [20, T0 + HOUR], [40, T0 + 2 * HOUR]]));
    const sorted = [...rows].sort((a, b) => a.id! - b.id!);
    for (let i = 1; i < sorted.length; i++) {
      expect(sorted[i]!.endedAt).toBeGreaterThanOrEqual(sorted[i - 1]!.endedAt);
    }
  });

  it('spreads equal games evenly between two anchors', () => {
    // Five 2x games: four intervals of 18s each, which is 10s of climb plus the
    // 8s of countdown and settle. Span the anchors by exactly that so the
    // interpolation has an exact answer to land on.
    const list = games(5);
    const rows = placeGamesInTime(list, new Map([[0, T0], [4, T0 + 72_000]]));
    const sorted = [...rows].sort((a, b) => a.id! - b.id!);
    expect(sorted.map((r) => r.endedAt - T0)).toEqual([0, 18_000, 36_000, 54_000, 72_000]);
  });

  it('gives the closing anchor game a share of the interval', () => {
    // The closing game ran to 500x, so it took most of the window and the games
    // before it must be squeezed towards the start.
    const list = [...games(3), { id: 99, hash: 'e'.repeat(64), bust: 500 }];
    const rows = placeGamesInTime(list, new Map([[0, T0], [3, T0 + 120_000]]));
    const byId = new Map(rows.map((r) => [r.id, r.endedAt]));
    expect(byId.get(list[2]!.id)! - T0).toBeLessThan(60_000);
  });

  it('gives a long game more of the interval than a short one', () => {
    const list: PlaceableGame[] = [
      { id: 1, hash: 'a'.repeat(64), bust: 1 },
      { id: 2, hash: 'b'.repeat(64), bust: 1 },
      { id: 3, hash: 'c'.repeat(64), bust: 500 },
      { id: 4, hash: 'd'.repeat(64), bust: 1 },
    ];
    const rows = placeGamesInTime(list, new Map([[0, T0], [4, T0 + 120_000]]));
    const byId = new Map(rows.map((r) => [r.id, r.endedAt]));
    const beforeBig = byId.get(3)! - byId.get(2)!;
    const afterBig = byId.get(4)! - byId.get(3)!;
    expect(beforeBig).toBeGreaterThan(afterBig);
  });

  describe('when the oldest timestamp could not be read', () => {
    it('still places the games before the first anchor', () => {
      // The regression this guards: those games used to be dropped silently.
      const list = games(20);
      const rows = placeGamesInTime(list, new Map([[10, T0 + HOUR], [20, T0 + 2 * HOUR]]));
      expect(rows).toHaveLength(20);
      expect(new Set(rows.map((r) => r.id)).size).toBe(20);
    });

    it('steps those games backwards in time from the first anchor', () => {
      const list = games(6);
      const rows = placeGamesInTime(list, new Map([[3, T0 + HOUR], [6, T0 + 2 * HOUR]]));
      const byId = new Map(rows.map((r) => [r.id, r]));
      const anchor = byId.get(list[3]!.id)!;
      expect(anchor.endedAt).toBe(T0 + HOUR);
      // Each earlier game sits one game-duration further back, 18s for a 2x.
      expect(anchor.endedAt - byId.get(list[2]!.id)!.endedAt).toBeCloseTo(18_000, -2);
      expect(byId.get(list[0]!.id)!.endedAt).toBeLessThan(byId.get(list[1]!.id)!.endedAt);
      expect(byId.get(list[0]!.id)!.tsSource).toBe('interp');
    });
  });

  it('places games after the last anchor when no end was supplied', () => {
    const list = games(6);
    const rows = placeGamesInTime(list, new Map([[0, T0], [3, T0 + 54_000]]));
    expect(rows).toHaveLength(6);
    const byId = new Map(rows.map((r) => [r.id, r]));
    expect(byId.get(list[5]!.id)!.endedAt).toBeGreaterThan(byId.get(list[3]!.id)!.endedAt);
  });

  it('handles a single anchor covering the whole run', () => {
    const list = games(5);
    const rows = placeGamesInTime(list, new Map([[2, T0]]));
    expect(rows).toHaveLength(5);
    expect(rows.find((r) => r.id === list[2]!.id)!.tsSource).toBe('rpc');
  });

  it('returns nothing when there are no anchors at all', () => {
    expect(placeGamesInTime(games(5), new Map())).toEqual([]);
  });

  it('rounds timestamps to whole milliseconds', () => {
    const rows = placeGamesInTime(games(3, 1.37), new Map([[0, T0], [3, T0 + 50_001]]));
    for (const row of rows) expect(Number.isInteger(row.endedAt)).toBe(true);
  });

  it('carries the game number, hash and multiplier through unchanged', () => {
    const list = games(3);
    const rows = placeGamesInTime(list, new Map([[0, T0], [3, T0 + 30_000]]));
    const row = rows.find((r) => r.id === list[1]!.id)!;
    expect(row.hash).toBe(list[1]!.hash);
    expect(row.bust).toBe(list[1]!.bust);
    expect(row.forcedAt).toBeNull();
  });
});

describe('when the only anchor closes the batch', () => {
  it('places every game instead of running off the end', () => {
    // A segment whose sole anchor is the already-stored game just past it.
    // Reading games[length] here used to throw.
    const list = games(4);
    const rows = placeGamesInTime(list, new Map([[4, T0 + 72_000]]));
    expect(rows).toHaveLength(4);
    expect(new Set(rows.map((r) => r.id)).size).toBe(4);
    const sorted = [...rows].sort((a, b) => a.id! - b.id!);
    for (let i = 1; i < sorted.length; i++) {
      expect(sorted[i]!.endedAt).toBeGreaterThan(sorted[i - 1]!.endedAt);
      expect(sorted[i]!.tsSource).toBe('interp');
    }
    expect(sorted.at(-1)!.endedAt).toBeLessThan(T0 + 72_000);
  });
});
