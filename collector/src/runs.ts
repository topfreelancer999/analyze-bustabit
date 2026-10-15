import { writeFileSync } from 'node:fs';
import { loadConfig, log, logError } from './config.ts';
import { GameStore } from './db.ts';
import { BrowserSource, findBrowser } from './browser-transport.ts';
import { endedAtFromCreated } from './recorder.ts';
import { expectedShareBelow } from '../../shared/expected.ts';

/**
 * Finds every stretch of consecutive games that all busted below a threshold,
 * and reports when each happened.
 *
 * Runs are counted over the game sequence, not the clock, so a gap in the
 * database would break a stretch that really was continuous. The scan refuses
 * to run if the numbering is not contiguous, rather than report a shorter
 * stretch than actually happened.
 *
 * Usage:
 *   npm run runs                                    # 10+ games under 2.00x
 *   npm run runs -- --under 1.5 --min 8
 *   npm run runs -- --verify 20                     # exact times for the longest 20
 *   npm run runs -- --csv data/low-runs.csv
 */

interface Options {
  under: number;
  min: number;
  csv: string;
  /** Read exact times from the site for the longest N runs. */
  verify: number;
  /** How many to print. */
  show: number;
  verifyDelayMs: number;
}

function parseOptions(argv: string[]): Options {
  const value = (name: string): string | undefined => {
    const index = argv.indexOf(`--${name}`);
    if (index >= 0 && argv[index + 1]) return argv[index + 1];
    return argv.find((a) => a.startsWith(`--${name}=`))?.split('=')[1];
  };
  const number = (name: string, fallback: number): number => {
    const raw = value(name);
    const parsed = raw === undefined ? NaN : Number(raw);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
  };
  return {
    under: number('under', 2),
    min: Math.floor(number('min', 10)),
    csv: value('csv') ?? 'data/low-runs.csv',
    verify: Math.floor(number('verify', 0)),
    show: Math.floor(number('show', 15)),
    verifyDelayMs: number('verify-delay', 2_000),
  };
}

const options = parseOptions(process.argv.slice(2));
const config = loadConfig();
const store = new GameStore(config.dbPath);

interface Row {
  id: number;
  bust: number;
  ended_at: number;
  ts_source: string;
}

interface LowRun {
  startId: number;
  endId: number;
  length: number;
  startedAt: number;
  endedAt: number;
  busts: number[];
  /** True once the start time has been read back from the site. */
  exact: boolean;
}

const stats = store.stats();
if (stats.gamesStored === 0) {
  logError('no games stored yet');
  store.close();
  process.exit(1);
}

log(
  `scanning ${stats.gamesStored.toLocaleString()} games for runs of ${options.min}+ ` +
    `consecutive busts under ${options.under.toFixed(2)}x`,
);

const rows = store.allOrderedById() as unknown as Row[];

// A stretch is only continuous if the game numbers are. Say so rather than
// silently splitting a run across a hole in the data.
let breaks = 0;
for (let i = 1; i < rows.length; i++) {
  if (rows[i]!.id !== rows[i - 1]!.id + 1) breaks++;
}
if (breaks > 0) {
  logError(
    `the stored games are not contiguous (${breaks} gap(s)). Runs spanning a gap would be ` +
      'reported short. Backfill the missing games first.',
  );
  store.close();
  process.exit(1);
}

const runs: LowRun[] = [];
let start = -1;
for (let i = 0; i <= rows.length; i++) {
  const low = i < rows.length && rows[i]!.bust < options.under;
  if (low) {
    if (start < 0) start = i;
    continue;
  }
  if (start >= 0 && i - start >= options.min) {
    const slice = rows.slice(start, i);
    runs.push({
      startId: slice[0]!.id,
      endId: slice.at(-1)!.id,
      length: slice.length,
      startedAt: slice[0]!.ended_at,
      endedAt: slice.at(-1)!.ended_at,
      busts: slice.map((r) => r.bust),
      exact: slice[0]!.ts_source !== 'interp',
    });
  }
  start = -1;
}

if (runs.length === 0) {
  log('no runs found');
  store.close();
  process.exit(0);
}

// What a fair game would produce, for comparison.
const p = expectedShareBelow(options.under);
const expected = rows.length * Math.pow(p, options.min) * (1 - p);

const byLength = new Map<number, number>();
for (const run of runs) byLength.set(run.length, (byLength.get(run.length) ?? 0) + 1);
const longest = Math.max(...runs.map((r) => r.length));

log(
  `found ${runs.length.toLocaleString()} runs (a fair game predicts about ${Math.round(expected)})`,
);
log(`longest: ${longest} games`);

if (options.verify > 0) {
  const targets = [...runs].sort((a, b) => b.length - a.length).slice(0, options.verify);
  const browserPath = findBrowser(config.browserPath || undefined);
  if (!browserPath) {
    logError('no browser found, skipping verification');
  } else {
    const source = new BrowserSource(config, browserPath);
    try {
      await new Promise<void>((resolve, reject) => {
        source.once('ready', () => resolve());
        source.once('fatal', (reason) => reject(new Error(reason)));
        setTimeout(() => reject(new Error('the browser never reached the site')), 90_000);
        source.start();
      });
      log(`reading exact times for the ${targets.length} longest runs`);

      for (const run of targets) {
        const info = await source.fetchGameInfo(run.startId);
        if (info?.created != null) {
          const before = run.startedAt;
          run.startedAt = Math.round(endedAtFromCreated(info.created, info.bust));
          run.endedAt += run.startedAt - before;
          run.exact = true;
        } else {
          logError(`could not read a time for game #${run.startId}`);
        }
        await delay(options.verifyDelayMs);
      }
    } catch (error) {
      logError('verification failed:', (error as Error).message);
    } finally {
      source.stop();
    }
  }
}

const sorted = [...runs].sort((a, b) => b.length - a.length || a.startId - b.startId);

console.log('');
console.log(`Longest ${Math.min(options.show, sorted.length)} runs of ${options.min}+ games under ${options.under.toFixed(2)}x`);
console.log('');
console.log('  len  games                  date        UTC       local        duration');
for (const run of sorted.slice(0, options.show)) {
  const d = new Date(run.startedAt);
  console.log(
    `  ${String(run.length).padStart(3)}  #${run.startId}-${String(run.endId).slice(-4)}  ` +
      `${d.toISOString().slice(0, 10)}  ${d.toISOString().slice(11, 19)}  ` +
      `${localClock(d)}  ${formatSpan(run.endedAt - run.startedAt)}${run.exact ? '  exact' : ''}`,
  );
}

console.log('');
console.log('  length  count');
for (const len of [...byLength.keys()].sort((a, b) => a - b)) {
  console.log(`  ${String(len).padStart(6)}  ${byLength.get(len)}`);
}

const header =
  'start_game,end_game,length,start_utc,end_utc,start_local,duration_seconds,time_source,busts';
const lines = [...runs]
  .sort((a, b) => a.startId - b.startId)
  .map((run) => {
    const start = new Date(run.startedAt);
    return [
      run.startId,
      run.endId,
      run.length,
      start.toISOString(),
      new Date(run.endedAt).toISOString(),
      `${start.toISOString().slice(0, 10)} ${localClock(start)}`,
      Math.round((run.endedAt - run.startedAt) / 1000),
      run.exact ? 'measured' : 'estimated',
      `"${run.busts.map((b) => b.toFixed(2)).join(' ')}"`,
    ].join(',');
  });

writeFileSync(options.csv, `${header}\n${lines.join('\n')}\n`, 'utf8');
console.log('');
log(`wrote ${runs.length.toLocaleString()} runs to ${options.csv}`);

store.close();

function localClock(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function formatSpan(ms: number): string {
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
