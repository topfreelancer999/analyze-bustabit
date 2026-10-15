import type { Tz } from '@shared/stats.ts';

export type RangeMode = 'day' | 'last24h' | 'last7d';

interface Props {
  rangeMode: RangeMode;
  onRangeMode: (mode: RangeMode) => void;
  day: string;
  onDay: (day: string) => void;
  tz: Tz;
  onTz: (tz: Tz) => void;
  lowThreshold: number;
  onLowThreshold: (value: number) => void;
  highThreshold: number;
  onHighThreshold: (value: number) => void;
}

const LOW_CHOICES = [1.1, 1.5, 2, 3];
const HIGH_CHOICES = [5, 10, 20, 100];

/** One row of filters above the charts: what window, in which clock, against what cutoffs. */
export function Controls(props: Props) {
  return (
    <div className="card controls">
      <div className="field">
        <label htmlFor="range">Window</label>
        <div className="segmented" id="range">
          <button
            type="button"
            aria-pressed={props.rangeMode === 'day'}
            onClick={() => props.onRangeMode('day')}
          >
            Day
          </button>
          <button
            type="button"
            aria-pressed={props.rangeMode === 'last24h'}
            onClick={() => props.onRangeMode('last24h')}
          >
            Last 24h
          </button>
          <button
            type="button"
            aria-pressed={props.rangeMode === 'last7d'}
            onClick={() => props.onRangeMode('last7d')}
          >
            Last 7d
          </button>
        </div>
      </div>

      {props.rangeMode === 'day' && (
        <div className="field">
          <label htmlFor="day">Date</label>
          <input
            id="day"
            type="date"
            value={props.day}
            onChange={(event) => props.onDay(event.target.value)}
          />
        </div>
      )}

      <div className="field">
        <label htmlFor="tz">Clock</label>
        <div className="segmented" id="tz">
          <button type="button" aria-pressed={props.tz === 'local'} onClick={() => props.onTz('local')}>
            Local
          </button>
          <button type="button" aria-pressed={props.tz === 'utc'} onClick={() => props.onTz('utc')}>
            UTC
          </button>
        </div>
      </div>

      <div className="field">
        <label htmlFor="low">Low bust under</label>
        <select
          id="low"
          value={props.lowThreshold}
          onChange={(event) => props.onLowThreshold(Number(event.target.value))}
        >
          {LOW_CHOICES.map((value) => (
            <option key={value} value={value}>
              {value.toFixed(2)}x
            </option>
          ))}
        </select>
      </div>

      <div className="field">
        <label htmlFor="high">Big win at</label>
        <select
          id="high"
          value={props.highThreshold}
          onChange={(event) => props.onHighThreshold(Number(event.target.value))}
        >
          {HIGH_CHOICES.map((value) => (
            <option key={value} value={value}>
              {value.toFixed(0)}x
            </option>
          ))}
        </select>
      </div>
    </div>
  );
}
