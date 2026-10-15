import { loadConfig, log, logError } from './config.ts';
import { GameStore } from './db.ts';
import { BrowserSource, findBrowser } from './browser-transport.ts';
import { endedAtFromCreated, linkMissingIds } from './recorder.ts';
import { placeGamesInTime, type PlaceableGame } from './timeline.ts';
import {
  bustsEqual,
  gameResult,
  previousHash,
  VX_LAST_GAME,
  type VerifierMode,
} from './verify.ts';

/**
 * Fills in history from before the collector was running.
 *
 * The crash points cost nothing: each game's hash is the SHA-256 of the next
 * one's, so walking the chain backwards from a game we already have regenerates
 * every earlier bust exactly, offline. A million games take about seven seconds.
 *
 * Timestamps are the expensive part, because they are not in the chain. The only
 * place bustabit exposes one is the game's own page, so this reads a few dozen
 * spread across the range and works out the games between them from how long
 * each would have taken. Those are marked estimated, so the dashboard can say
 * which times were measured.
 *
 * The walk runs twice: once to find the games to ask about, and again to place
 * and store them a segment at a time. That keeps memory flat however far back
 * the request goes, and means an interrupted run keeps what it already wrote.
 *
 * Usage:
 *   npm run backfill -- --days 30
 *   npm run backfill -- --games 5000 [--anchor-every 500] [--max-anchors 150]
 */

interface Options {
  /** Requested days of history, or 0 when a game count was given instead. */
  days: number;
  games: number;
  /** Games between measured timestamps, or 0 to derive it from the range. */
  anchorEvery: number;
  /** Ceiling on how many timestamps to request, which bounds the run. */
  maxAnchors: number;
  dryRun: boolean;
  /** Pause between requests, to stay gentle on the site. */
  anchorDelayMs: number;
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
    return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
  };
  return {
    days: number('days', 0),
    games: number('games', 5_000),
    anchorEvery: number('anchor-every', 0),
    maxAnchors: number('max-anchors', 150),
    dryRun: argv.includes('--dry-run'),
    anchorDelayMs: number('anchor-delay', 2_000),
  };
}

const options = parseOptions(process.argv.slice(2));
const config = loadConfig();
const store = new GameStore(config.dbPath);

const mode: VerifierMode = (store.getMeta('verifier_mode') as VerifierMode | null) ?? 'raw';

/** Walk back from the oldest game held, so the window only ever grows. */
const anchorRow = store.earliestWithId();
if (!anchorRow) {
  logError(
    'Nothing to walk back from. Run the collector first so at least one game with ' +
      'a known number is stored, then run the backfill.',
  );
  store.close();
  process.exit(1);
}

const startId = anchorRow.id!;

/**
 * Games per day, measured from what is already stored so the estimate reflects
 * the real cadence. Falls back to the long-run average of a game every 22s.
 */
function gamesPerDay(): number {
  const stats = store.stats();
  if (stats.oldest !== null && stats.newest !== null && stats.gamesStored > 200) {
    const span = stats.newest - stats.oldest;
    if (span > 3_600_000) return (stats.gamesStored / span) * 86_400_000;
  }
  return 3_900;
}

const rate = gamesPerDay();
const requested = options.days > 0 ? Math.ceil(options.days * rate) : options.games;

// The chain can only be replayed back to the current salt. Earlier games were
// signed under a scheme this does not implement, so stop rather than guess.
const replayable = startId - VX_LAST_GAME - 1;
const total = Math.max(0, Math.min(requested, replayable));

if (total === 0) {
  log(
    `Already back to game #${startId}, the oldest the current salt can replay. ` +
      'Earlier games used a different signing scheme.',
  );
  store.close();
  process.exit(0);
}

// Spread the timestamp requests across the range rather than fixing the spacing,
// so asking for a year does not mean thousands of them.
const spacing =
  options.anchorEvery > 0
    ? options.anchorEvery
    : Math.max(250, Math.ceil(total / options.maxAnchors));
const anchorCount = Math.ceil(total / spacing);
const estimateMs = anchorCount * (options.anchorDelayMs + 500);

log(
  options.days > 0
    ? `${options.days} day(s) at ${Math.round(rate)} games/day means ${requested.toLocaleString()} games`
    : `${requested.toLocaleString()} games requested`,
);
if (total < requested) {
  log(
    `only ${total.toLocaleString()} can be replayed before the salt changes at ` +
      `#${VX_LAST_GAME + 1}, about ${(total / rate).toFixed(0)} days`,
  );
}
log(
  `plan: ${total.toLocaleString()} games back from #${startId}, ` +
    `${anchorCount} timestamps every ${spacing.toLocaleString()} games, ` +
    `about ${Math.ceil(estimateMs / 60_000)} min`,
);

/** Oldest-first index of every game whose timestamp will be measured. */
const anchorIndices: number[] = [];
for (let i = 0; i < total; i += spacing) anchorIndices.push(i);

/**
 * Walk the chain backwards, reporting each game with its oldest-first index.
 * Games arrive newest first; only the caller decides what to keep.
 */
function walk(onGame: (index: number, game: PlaceableGame) => void): void {
  let hash = anchorRow!.hash;
  for (let step = 1; step <= total; step++) {
    hash = previousHash(hash);
    onGame(total - step, { id: startId - step, hash, bust: gameResult(hash, mode) });
  }
}

// Pass one: find the games to ask about. Nothing else is kept, so memory stays
// proportional to the number of timestamps rather than the size of the range.
const wanted = new Set(anchorIndices);
const anchorGames = new Map<number, PlaceableGame>();
const walkStarted = Date.now();
walk((index, game) => {
  if (wanted.has(index)) anchorGames.set(index, game);
});
log(
  `regenerated ${total.toLocaleString()} games (#${startId - total} to #${startId - 1}) ` +
    `in ${((Date.now() - walkStarted) / 1000).toFixed(1)}s`,
);

if (options.dryRun) {
  const sample = [...anchorGames.entries()]
    .sort((a, b) => b[0] - a[0])
    .slice(0, 4)
    .map(([, g]) => `#${g.id}=${g.bust}x`);
  log(`dry run, nothing written. Sample: ${sample.join(' ')}`);
  store.close();
  process.exit(0);
}

const browserPath = findBrowser(config.browserPath || undefined);
if (!browserPath) {
  logError('no Chrome or Edge found. Set BUSTABIT_BROWSER_PATH and try again.');
  store.close();
  process.exit(1);
}

const source = new BrowserSource(config, browserPath);
const ready = new Promise<void>((resolve, reject) => {
  source.once('ready', () => resolve());
  source.once('fatal', (reason) => reject(new Error(reason)));
  setTimeout(() => reject(new Error('the browser never reached the site')), 90_000);
});
source.start();

let inserted = 0;
let measured = 0;

try {
  await ready;
  log(`site loaded, reading ${anchorCount} timestamps`);

  /** Oldest-first index -> that game's measured crash time. */
  const anchors = new Map<number, number>();
  let failed = 0;
  let done = 0;

  for (const index of anchorIndices) {
    const game = anchorGames.get(index)!;
    const info = await source.fetchGameInfo(game.id);
    done++;

    if (!info || info.created === null) {
      failed++;
      logError(`could not read a timestamp for game #${game.id}`);
    } else if (!bustsEqual(info.bust, game.bust)) {
      // The site disagrees with the chain, so the walk is off its anchor.
      throw new Error(
        `game #${game.id}: the site reports ${info.bust}x but the chain gives ${game.bust}x. ` +
          'Nothing was written.',
      );
    } else {
      anchors.set(index, endedAtFromCreated(info.created, game.bust));
      measured++;
    }

    if (done % 10 === 0 || done === anchorIndices.length) {
      log(`  ${done}/${anchorIndices.length} timestamps read`);
    }
    await delay(options.anchorDelayMs);
  }

  if (anchors.size === 0) {
    throw new Error('no timestamps could be read, so nothing can be placed in time');
  }

  // Pass two: place and store one segment at a time, newest segment first, so an
  // interrupted run leaves a contiguous block next to what was already stored.
  let segmentEndTime = anchorRow.endedAt;
  let pending: PlaceableGame[] = [];
  let lastLogged = Date.now();

  const flush = (startIndex: number): void => {
    if (pending.length === 0) return;
    const games = pending.reverse(); // the walk yields newest first
    pending = [];

    const local = new Map<number, number>();
    const startTime = anchors.get(startIndex);
    if (startTime !== undefined) local.set(0, startTime);
    // The closing anchor sits just past this segment; its time is already known.
    local.set(games.length, segmentEndTime);

    inserted += store.insertMany(placeGamesInTime(games, local));
    if (startTime !== undefined) segmentEndTime = startTime;
  };

  walk((index, game) => {
    pending.push(game);
    if (!anchors.has(index) && index !== 0) return;
    flush(index);
    if (Date.now() - lastLogged > 5_000) {
      lastLogged = Date.now();
      log(`  stored ${inserted.toLocaleString()} of ${total.toLocaleString()}`);
    }
  });
  flush(0);

  const numbered = linkMissingIds(store);
  if (numbered > 0) log(`numbered ${numbered} previously unnumbered game(s) from the chain`);

  log(
    `stored ${inserted.toLocaleString()} new games ` +
      `(${measured} with a measured time, the rest estimated)` +
      (failed > 0 ? `, ${failed} timestamps unavailable` : ''),
  );

  const stats = store.stats();
  log(
    `database now holds ${stats.gamesStored.toLocaleString()} games from ` +
      `${new Date(stats.oldest!).toISOString()} to ${new Date(stats.newest!).toISOString()}`,
  );
} catch (error) {
  logError('backfill failed:', (error as Error).message);
  if (inserted > 0) {
    log(`${inserted.toLocaleString()} games were stored before the failure and are kept; rerun to continue`);
  }
  process.exitCode = 1;
} finally {
  source.stop();
  store.close();
  setTimeout(() => process.exit(process.exitCode ?? 0), 300).unref();
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
