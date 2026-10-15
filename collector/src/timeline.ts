import type { GameRow } from './db.ts';
import { gameDurationMs, interpolateTimestamps } from './recorder.ts';

/**
 * Placing regenerated games in time.
 *
 * The hash chain gives every past game's number and multiplier but no clock.
 * The backfill reads a real timestamp for one game in every few hundred, and
 * this spreads the games between two of those anchors according to how long
 * each would have taken, so a long game occupies more of the interval than a
 * short one.
 */

export interface PlaceableGame {
  id: number;
  hash: string;
  bust: number;
}

/**
 * Turn regenerated games into rows with timestamps.
 *
 * `anchors` maps an index in `games` to that game's measured crash time. It may
 * also carry an entry at `games.length` for the already-known game the walk
 * started from, which bounds the newest segment.
 *
 * Anchored games are marked 'rpc' because their time was measured; everything
 * else is 'interp' because it was worked out.
 */
export function placeGamesInTime(
  games: PlaceableGame[],
  anchors: Map<number, number>,
): GameRow[] {
  const indices = [...anchors.keys()].sort((a, b) => a - b);
  if (indices.length === 0) return [];
  const rows: GameRow[] = [];

  // Games older than the first anchor have nothing to interpolate between,
  // which happens when the oldest timestamp could not be read. Step backwards
  // from that anchor using each game's own duration rather than dropping them.
  const first = indices[0]!;
  if (first > 0) {
    let time = anchors.get(first)!;
    for (let i = first - 1; i >= 0; i--) {
      // The anchor may sit past the end of this batch, in which case its own
      // multiplier is unknown and only the fixed part of its cycle is counted.
      time -= gameDurationMs(games[i + 1]?.bust ?? 0);
      rows.push(toRow(games[i]!, time, 'interp'));
    }
  }

  for (let i = 0; i < indices.length; i++) {
    const from = indices[i]!;
    const to = indices[i + 1];
    if (from < games.length) rows.push(toRow(games[from]!, anchors.get(from)!, 'rpc'));
    if (to === undefined) break;

    const between = games.slice(from + 1, to);
    if (between.length === 0) continue;
    // The interval also contains the closing anchor game's own run, so it takes
    // a share of the weight. Its multiplier is known unless the anchor is the
    // already-stored game the walk started from, which is not in this list.
    const closingBust = games[to]?.bust ?? 0;
    const times = interpolateTimestamps(anchors.get(from)!, anchors.get(to)!, [
      ...between.map((g) => g.bust),
      closingBust,
    ]);
    between.forEach((game, offset) => rows.push(toRow(game, times[offset]!, 'interp')));
  }

  // Games newer than the last anchor, when the walk's own end was not supplied.
  const last = indices[indices.length - 1]!;
  if (last < games.length - 1 && anchors.has(last)) {
    let time = anchors.get(last)!;
    for (let i = last + 1; i < games.length; i++) {
      time += gameDurationMs(games[i]!.bust);
      rows.push(toRow(games[i]!, time, 'interp'));
    }
  }

  return rows;
}

export function toRow(
  game: PlaceableGame,
  endedAt: number,
  tsSource: 'rpc' | 'interp',
): GameRow {
  return {
    hash: game.hash,
    id: game.id,
    bust: game.bust,
    forcedAt: null,
    endedAt: Math.round(endedAt),
    tsSource,
  };
}
