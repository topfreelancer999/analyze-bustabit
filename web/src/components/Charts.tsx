import { useMemo, useState } from 'react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ResponsiveContainer,
  Scatter,
  ScatterChart,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import type { Game } from '@shared/types.ts';
import {
  formatBust,
  formatClock,
  formatPercent,
  histogram,
  hourlyStats,
  type HourBucket,
  type Tz,
} from '@shared/stats.ts';

/**
 * The three charts.
 *
 * Each plots one measure on one axis. The distribution chart adds the
 * fair-game expectation as a second series, which is why it is the only one
 * with a legend. Every chart has a hover tooltip and a table equivalent
 * elsewhere on the page.
 */

const OBSERVED = 'var(--series-observed)';
const EXPECTED = 'var(--series-expected)';
const GRID = 'var(--gridline)';
const AXIS = 'var(--baseline)';
const MUTED = 'var(--text-muted)';

const axisStyle = { fill: MUTED, fontSize: 11 } as const;

interface TooltipRow {
  label: string;
  value: string;
}

function Card({
  title,
  note,
  legend,
  children,
}: {
  title: string;
  note?: string;
  legend?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="card">
      <div className="card-head">
        <h2>{title}</h2>
        {note && <span className="card-note">{note}</span>}
      </div>
      {legend}
      {children}
    </div>
  );
}

function Box({ title, rows }: { title: string; rows: TooltipRow[] }) {
  return (
    <div className="tooltip">
      <div className="tooltip-title">{title}</div>
      {rows.map((row) => (
        <div className="tooltip-row" key={row.label}>
          {row.label}: {row.value}
        </div>
      ))}
    </div>
  );
}

/** Share of games in each multiplier band, against what a fair game predicts. */
export function DistributionChart({ games }: { games: Game[] }) {
  const bins = useMemo(() => histogram(games.map((g) => g.bust)), [games]);
  const data = bins.map((bin) => ({
    label: bin.label,
    observed: bin.share * 100,
    expected: bin.expectedShare * 100,
    count: bin.count,
  }));

  return (
    <Card title="Distribution of crash points" note="share of games per band">
      <div className="legend">
        <span className="legend-key">
          <span className="swatch" style={{ background: OBSERVED }} /> Observed
        </span>
        <span className="legend-key">
          <span className="swatch" style={{ background: EXPECTED }} /> Fair game
        </span>
      </div>
      <ResponsiveContainer width="100%" height={240}>
        <BarChart data={data} margin={{ top: 4, right: 8, bottom: 4, left: 0 }} barGap={2}>
          <CartesianGrid stroke={GRID} vertical={false} />
          <XAxis
            dataKey="label"
            tick={axisStyle}
            stroke={AXIS}
            interval={0}
            angle={-35}
            textAnchor="end"
            height={54}
          />
          <YAxis
            tick={axisStyle}
            stroke={AXIS}
            tickFormatter={(value: number) => `${value}%`}
            width={44}
          />
          <Tooltip
            cursor={{ fill: GRID, fillOpacity: 0.4 }}
            content={({ active, payload, label }) => {
              if (!active || !payload?.length) return null;
              const row = payload[0]!.payload as (typeof data)[number];
              return (
                <Box
                  title={String(label)}
                  rows={[
                    { label: 'Games', value: row.count.toLocaleString() },
                    { label: 'Observed', value: `${row.observed.toFixed(1)}%` },
                    { label: 'Fair game', value: `${row.expected.toFixed(1)}%` },
                  ]}
                />
              );
            }}
          />
          <Bar dataKey="observed" fill={OBSERVED} radius={[4, 4, 0, 0]} maxBarSize={22} />
          <Bar dataKey="expected" fill={EXPECTED} radius={[4, 4, 0, 0]} maxBarSize={22} />
        </BarChart>
      </ResponsiveContainer>
    </Card>
  );
}

/** Every game in the window, on a log scale so both 1x and 500x are readable. */
export function TimelineChart({
  games,
  tz,
  highThreshold,
}: {
  games: Game[];
  tz: Tz;
  highThreshold: number;
}) {
  const data = useMemo(
    () =>
      games.map((game) => ({
        time: game.endedAt,
        bust: game.bust,
        id: game.id,
        interpolated: game.tsSource === 'interp',
      })),
    [games],
  );

  const maxBust = Math.max(10, ...games.map((g) => g.bust));
  // Log ticks up to the highest game in view.
  const ticks = [1, 2, 5, 10, 100, 1000].filter((t) => t <= maxBust * 1.5);

  return (
    <Card title="Crash points over time" note="log scale">
      <ResponsiveContainer width="100%" height={240}>
        <ScatterChart margin={{ top: 4, right: 8, bottom: 4, left: 0 }}>
          <CartesianGrid stroke={GRID} vertical={false} />
          <XAxis
            dataKey="time"
            type="number"
            domain={['dataMin', 'dataMax']}
            tick={axisStyle}
            stroke={AXIS}
            tickFormatter={(value: number) => formatClock(value, tz).slice(0, 5)}
            minTickGap={40}
          />
          <YAxis
            dataKey="bust"
            type="number"
            scale="log"
            domain={[1, Math.ceil(maxBust * 1.2)]}
            ticks={ticks}
            tick={axisStyle}
            stroke={AXIS}
            tickFormatter={(value: number) => `${value}x`}
            width={44}
            allowDataOverflow
          />
          <Tooltip
            content={({ active, payload }) => {
              if (!active || !payload?.length) return null;
              const row = payload[0]!.payload as (typeof data)[number];
              return (
                <Box
                  title={row.id === null ? 'Game' : `Game #${row.id.toLocaleString()}`}
                  rows={[
                    { label: 'Busted at', value: formatBust(row.bust) },
                    { label: 'Time', value: formatClock(row.time, tz) },
                    ...(row.interpolated
                      ? [{ label: 'Time source', value: 'estimated' }]
                      : []),
                  ]}
                />
              );
            }}
          />
          <Scatter data={data} fill={OBSERVED} shape="circle" isAnimationActive={false}>
            {data.map((row, index) => (
              <Cell
                key={index}
                // Big wins get the second hue so the eye can find them; the
                // y position already carries the value, so this is emphasis.
                fill={row.bust >= highThreshold ? EXPECTED : OBSERVED}
                r={row.bust >= highThreshold ? 5 : 4}
              />
            ))}
          </Scatter>
        </ScatterChart>
      </ResponsiveContainer>
    </Card>
  );
}

type HourMetric = 'count' | 'median' | 'shareBelow' | 'max';

const METRIC_LABEL: Record<HourMetric, string> = {
  count: 'Games',
  median: 'Median bust',
  shareBelow: 'Share under threshold',
  max: 'Highest bust',
};

/**
 * One metric per hour of the day. A toggle rather than several series at once,
 * because counts and multipliers do not share an axis.
 */
export function HourlyChart({
  buckets,
  lowThreshold,
}: {
  buckets: HourBucket[];
  lowThreshold: number;
}) {
  const [metric, setMetric] = useState<HourMetric>('count');
  const stats = useMemo(() => hourlyStats(buckets, lowThreshold), [buckets, lowThreshold]);

  const data = stats.map((row) => ({
    hour: String(row.hour).padStart(2, '0'),
    label: row.label,
    count: row.count,
    median: Number.isFinite(row.median) ? row.median : 0,
    shareBelow: Number.isFinite(row.shareBelow) ? row.shareBelow * 100 : 0,
    max: Number.isFinite(row.max) ? row.max : 0,
    empty: row.count === 0,
  }));

  const format = (value: number): string => {
    if (metric === 'count') return value.toLocaleString();
    if (metric === 'shareBelow') return `${value.toFixed(0)}%`;
    return `${value.toFixed(2)}x`;
  };

  return (
    <Card
      title="By hour of day"
      note={metric === 'shareBelow' ? `under ${formatBust(lowThreshold)}` : undefined}
      legend={
        <div className="legend">
          <div className="segmented">
            {(Object.keys(METRIC_LABEL) as HourMetric[]).map((key) => (
              <button
                key={key}
                type="button"
                aria-pressed={metric === key}
                onClick={() => setMetric(key)}
              >
                {METRIC_LABEL[key]}
              </button>
            ))}
          </div>
        </div>
      }
    >
      <ResponsiveContainer width="100%" height={240}>
        <BarChart data={data} margin={{ top: 4, right: 8, bottom: 4, left: 0 }}>
          <CartesianGrid stroke={GRID} vertical={false} />
          <XAxis dataKey="hour" tick={axisStyle} stroke={AXIS} interval={1} />
          <YAxis tick={axisStyle} stroke={AXIS} tickFormatter={format} width={48} />
          <Tooltip
            cursor={{ fill: GRID, fillOpacity: 0.4 }}
            content={({ active, payload }) => {
              if (!active || !payload?.length) return null;
              const row = payload[0]!.payload as (typeof data)[number];
              if (row.empty) return <Box title={row.label} rows={[{ label: 'Games', value: '0' }]} />;
              return (
                <Box
                  title={row.label}
                  rows={[
                    { label: 'Games', value: row.count.toLocaleString() },
                    { label: 'Median', value: formatBust(row.median) },
                    { label: `Under ${formatBust(lowThreshold)}`, value: `${row.shareBelow.toFixed(0)}%` },
                    { label: 'Highest', value: formatBust(row.max) },
                  ]}
                />
              );
            }}
          />
          <Bar dataKey={metric} fill={OBSERVED} radius={[4, 4, 0, 0]} maxBarSize={24} />
        </BarChart>
      </ResponsiveContainer>
    </Card>
  );
}

/** Threshold table: the numbers behind the distribution chart. */
export function ThresholdTable({
  shares,
}: {
  shares: Array<{
    threshold: number;
    below: number;
    atLeast: number;
    shareBelow: number;
    expectedBelow: number;
    delta: number;
  }>;
}) {
  return (
    <div className="card">
      <div className="card-head">
        <h2>Threshold breakdown</h2>
        <span className="card-note">observed against a provably fair game</span>
      </div>
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>Threshold</th>
              <th>Busted under</th>
              <th>Reached</th>
              <th>Observed</th>
              <th>Fair game</th>
              <th>Difference</th>
            </tr>
          </thead>
          <tbody>
            {shares.map((row) => (
              <tr key={row.threshold}>
                <td>{formatBust(row.threshold)}</td>
                <td>{row.below.toLocaleString()}</td>
                <td>{row.atLeast.toLocaleString()}</td>
                <td>{formatPercent(row.shareBelow)}</td>
                <td className="muted">{formatPercent(row.expectedBelow)}</td>
                <td>
                  {Number.isFinite(row.delta)
                    ? `${row.delta >= 0 ? '+' : ''}${(row.delta * 100).toFixed(1)}pp`
                    : '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
