import { useState } from 'react';
import { formatBust, formatPercent, median, type HourBucket } from '@shared/stats.ts';

interface Props {
  buckets: HourBucket[];
  lowThreshold: number;
  highThreshold: number;
  /** The day being shown, or null for a rolling window spanning several days. */
  dayLabel: string | null;
}

/** How many multipliers to show before collapsing the rest of the hour. */
const PREVIEW = 60;

/**
 * The per-hour list of raw multipliers, which is the view the project set out
 * to produce: one row per hour of the day, values in the order they happened.
 */
export function HourlyView({ buckets, lowThreshold, highThreshold, dayLabel }: Props) {
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const total = buckets.reduce((sum, bucket) => sum + bucket.games.length, 0);

  const toggle = (hour: number) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(hour)) next.delete(hour);
      else next.add(hour);
      return next;
    });
  };

  return (
    <div className="card">
      <div className="card-head">
        <h2>Busted values per hour{dayLabel ? ` — ${dayLabel}` : ''}</h2>
        <span className="card-note">
          {total.toLocaleString()} games, in the order they were played
        </span>
      </div>

      {total === 0 ? (
        <div className="empty">
          No games in this window yet. The collector stores games as they are played.
        </div>
      ) : (
        <div>
          {buckets.map((bucket) => {
            const busts = bucket.games.map((g) => g.bust);
            const isOpen = expanded.has(bucket.hour);
            const shown = isOpen ? bucket.games : bucket.games.slice(0, PREVIEW);
            const hidden = bucket.games.length - shown.length;
            const below = busts.filter((b) => b < lowThreshold).length;

            return (
              <div className="hour-row" key={bucket.hour}>
                <div className="hour-label">{bucket.label}</div>
                <div className="hour-meta">
                  {bucket.games.length === 0
                    ? '—'
                    : `${bucket.games.length} · ${formatBust(median(busts))} · ${formatPercent(
                        below / busts.length,
                        0,
                      )}`}
                </div>
                <div className="hour-values">
                  {bucket.games.length === 0 ? (
                    <span className="muted">no games</span>
                  ) : (
                    <>
                      {shown.map((game) => (
                        <span
                          key={game.hash}
                          className={`bust ${classOf(game.bust, lowThreshold, highThreshold)}`}
                          title={
                            game.id === null
                              ? formatBust(game.bust)
                              : `Game #${game.id.toLocaleString()} — ${formatBust(game.bust)}`
                          }
                        >
                          {formatBust(game.bust)}
                        </span>
                      ))}
                      {hidden > 0 && (
                        <button type="button" className="more" onClick={() => toggle(bucket.hour)}>
                          +{hidden} more
                        </button>
                      )}
                      {isOpen && bucket.games.length > PREVIEW && (
                        <button type="button" className="more" onClick={() => toggle(bucket.hour)}>
                          show fewer
                        </button>
                      )}
                    </>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
      <div className="card-note" style={{ marginTop: 10 }}>
        Each row reads count · median · share under {formatBust(lowThreshold)}. Weight marks a
        value at or above {formatBust(highThreshold)}; underline marks 10 times that.
      </div>
    </div>
  );
}

/**
 * Emphasis by weight rather than color, so the scan for big wins survives
 * printing and colorblindness.
 */
function classOf(bust: number, low: number, high: number): string {
  if (bust >= high * 10) return 'huge';
  if (bust >= high) return 'high';
  if (bust <= 1) return 'instant';
  if (bust < low) return 'instant';
  return '';
}
