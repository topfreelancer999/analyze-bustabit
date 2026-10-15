import type { Game } from '@shared/types.ts';
import {
  formatBust,
  formatDuration,
  formatPercent,
  gamesSinceLast,
  longestLowRun,
  summary,
} from '@shared/stats.ts';
import { expectedShareBelow, EXPECTED_INSTANT_BUST_SHARE, FAIR_MEDIAN } from '@shared/expected.ts';

interface Props {
  games: Game[];
  lowThreshold: number;
  highThreshold: number;
}

interface TileProps {
  label: string;
  value: string;
  note?: string;
}

function Tile({ label, value, note }: TileProps) {
  return (
    <div className="card">
      <div className="tile-label">{label}</div>
      <div className="tile-value">{value}</div>
      {note && <div className="tile-note">{note}</div>}
    </div>
  );
}

/**
 * The headline numbers. Each shows what a fair game would give beside it,
 * because on a provably fair game that is the only honest reference point.
 */
export function StatTiles({ games, lowThreshold, highThreshold }: Props) {
  const busts = games.map((g) => g.bust);
  const stats = summary(busts);
  const belowLow = busts.filter((b) => b < lowThreshold).length;
  const shareBelow = stats.count === 0 ? NaN : belowLow / stats.count;
  const run = longestLowRun(busts, lowThreshold);
  const since = gamesSinceLast(games, highThreshold);

  return (
    <div className="tiles">
      <Tile
        label="Games"
        value={stats.count.toLocaleString()}
        note={stats.count === 0 ? 'nothing collected yet' : undefined}
      />
      <Tile
        label="Median bust"
        value={formatBust(stats.median)}
        note={`fair game: ${FAIR_MEDIAN.toFixed(2)}x`}
      />
      <Tile
        label={`Under ${formatBust(lowThreshold)}`}
        value={formatPercent(shareBelow)}
        note={`fair game: ${formatPercent(expectedShareBelow(lowThreshold))}`}
      />
      <Tile
        label="Instant busts"
        value={formatPercent(stats.count === 0 ? NaN : stats.instantBusts / stats.count)}
        note={`fair game: ${formatPercent(EXPECTED_INSTANT_BUST_SHARE)}`}
      />
      <Tile
        label={`Longest run under ${formatBust(lowThreshold)}`}
        value={run.length === 0 ? '—' : `${run.length} games`}
      />
      <Tile
        label={`Since last ${highThreshold}x`}
        value={since === null ? 'none yet' : `${since.games} games`}
        note={since === null ? `highest was ${formatBust(stats.max)}` : formatDuration(since.ms)}
      />
    </div>
  );
}
