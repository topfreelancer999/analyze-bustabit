import { useMemo } from 'react';
import { Controls, type RangeMode } from './components/Controls.tsx';
import { StatusBar } from './components/StatusBar.tsx';
import { StatTiles } from './components/StatTiles.tsx';
import {
  DistributionChart,
  HourlyChart,
  ThresholdTable,
  TimelineChart,
} from './components/Charts.tsx';
import { HourlyView } from './components/HourlyView.tsx';
import { useGames, useStatus } from './hooks/usePolling.ts';
import { usePref } from './hooks/usePref.ts';
import {
  dayBoundsFromKey,
  dayKey,
  groupByHour,
  thresholdShares,
  type Tz,
} from '@shared/stats.ts';

const DAY_MS = 86_400_000;

export function App() {
  const [rangeMode, setRangeMode] = usePref<RangeMode>('bb.range', 'day');
  const [tz, setTz] = usePref<Tz>('bb.tz', 'local');
  const [day, setDay] = usePref<string>('bb.day', dayKey(Date.now(), 'local'));
  const [lowRaw, setLow] = usePref<string>('bb.low', '2');
  const [highRaw, setHigh] = usePref<string>('bb.high', '10');
  const lowThreshold = Number(lowRaw);
  const highThreshold = Number(highRaw);

  // Rolling windows are anchored to whole minutes so the polling interval does
  // not refetch a slightly different range every 15 seconds.
  const { from, to } = useMemo(() => {
    if (rangeMode === 'day') return dayBoundsFromKey(day, tz);
    const now = Math.ceil(Date.now() / 60_000) * 60_000;
    return { from: now - (rangeMode === 'last7d' ? 7 * DAY_MS : DAY_MS), to: now };
  }, [rangeMode, day, tz]);

  const status = useStatus();
  const games = useGames(from, to);
  const rows = games.data ?? [];

  const buckets = useMemo(() => groupByHour(rows, tz), [rows, tz]);
  const shares = useMemo(() => thresholdShares(rows.map((g) => g.bust)), [rows]);

  return (
    <div className="app">
      <header>
        <h1>Bustabit hourly analysis</h1>
        <p className="subtitle">
          Crash multipliers collected live and grouped by hour of the day. Every game is checked
          against bustabit's provably fair formula before it is stored, so the values here are the
          ones the game published. Because each crash point comes from a hash chain committed
          before the games were played, it cannot depend on the time of day: differences between
          hours are sampling noise, which is why each figure is shown beside what a fair game
          gives.
        </p>
      </header>

      <StatusBar status={status.data} error={status.error} />

      <Controls
        rangeMode={rangeMode}
        onRangeMode={setRangeMode}
        day={day}
        onDay={setDay}
        tz={tz}
        onTz={setTz}
        lowThreshold={lowThreshold}
        onLowThreshold={(value) => setLow(String(value))}
        highThreshold={highThreshold}
        onHighThreshold={(value) => setHigh(String(value))}
      />

      {games.error && <div className="banner error">Could not load games: {games.error}</div>}
      {games.truncated && (
        <div className="banner warn">
          This window hit the row limit, so the numbers below cover only part of it. Narrow the
          range for an exact answer.
        </div>
      )}

      <StatTiles games={rows} lowThreshold={lowThreshold} highThreshold={highThreshold} />

      <div className="charts">
        <DistributionChart games={rows} />
        <TimelineChart games={rows} tz={tz} highThreshold={highThreshold} />
      </div>

      <HourlyChart buckets={buckets} lowThreshold={lowThreshold} />

      <ThresholdTable shares={shares} />

      <HourlyView
        buckets={buckets}
        lowThreshold={lowThreshold}
        highThreshold={highThreshold}
        dayLabel={rangeMode === 'day' ? day : null}
      />

      <footer className="card-note">
        Times are shown in {tz === 'utc' ? 'UTC' : 'local time'}. Games recovered from the hash
        chain after a gap carry an estimated timestamp, marked in the timeline tooltip.
      </footer>
    </div>
  );
}
