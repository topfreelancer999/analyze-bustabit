import { loadConfig, log, logError } from './config.ts';
import { GameStore } from './db.ts';
import { expectedShareAtLeast, expectedShareBelow } from '../../shared/expected.ts';
import { dayKey, type Tz } from '../../shared/stats.ts';

/**
 * Replays a streak-triggered ladder over the stored games.
 *
 * The idea being tested: wait for a run of `--after` or more consecutive games
 * under `--under`; when a game at or above it ends the run, start a ladder of
 * bets on the games that follow, stopping at the first win. Then wait for the
 * next run.
 *
 * The ladder is either explicit (`--ladder 50000@2,100000@2.5,200000@3`) or
 * open-ended: start at `--base`, multiply the stake by `--factor` and add
 * `--step` to the target after each loss, and keep going until a win or until
 * the next stake cannot be placed. When it cannot, everything staked in that
 * ladder stays lost and the bot waits for the next trigger with what is left.
 *
 * A daily stop-loss (`--stop-loss N`) halts betting for the rest of the day once
 * that day's net loss reaches N. By default it is checked before every bet, so
 * it can abandon a ladder part-way; `--stop-loss-mode ladder` checks it only
 * before starting a ladder and lets a started one run.
 *
 * Usage:
 *   npm run simulate:after -- --balance 2000000 --after 10 --base 10000 --step 0.5
 *   npm run simulate:after -- --stop-loss 80000 [--stop-loss-mode ladder] [--tz local]
 *   npm run simulate:after -- --trace
 */

interface Rung {
  stake: number;
  target: number;
}

interface Options {
  balance: number;
  after: number;
  under: number;
  /** Explicit rungs, or empty to generate them from base, factor, target and step. */
  ladder: Rung[];
  base: number;
  /** Stake multiplier between rungs. */
  factor: number;
  target: number;
  /** Added to the target on each rung. */
  step: number;
  /** Print one line per ladder played. */
  trace: boolean;
  /** Daily loss at which betting stops for the day; 0 disables. */
  stopLoss: number;
  /** 'bet' checks before every bet, 'ladder' only before starting one. */
  stopLossMode: 'bet' | 'ladder';
  /** Which clock defines a day. */
  tz: Tz;
  /** Shift the day boundary by this many hours from UTC midnight; overrides tz. */
  dayOffset: number | null;
  /** Refuse any bet that, if lost, would take the day past the stop-loss. */
  strict: boolean;
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
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
  };
  const ladderRaw = value('ladder');
  const ladder = ladderRaw
    ? ladderRaw.split(',').map((part) => {
        const [stake, target] = part.split('@').map(Number);
        if (!stake || !target || target <= 1) throw new Error(`bad ladder rung: ${part}`);
        return { stake, target };
      })
    : [];
  const stepRaw = value('step');
  return {
    balance: number('balance', 2_000_000),
    after: Math.floor(number('after', 10)),
    under: number('under', 2),
    ladder,
    base: number('base', 10_000),
    factor: number('factor', 2),
    target: number('target', 2),
    step: stepRaw === undefined ? 0.5 : Number(stepRaw) || 0,
    trace: argv.includes('--trace'),
    stopLoss: number('stop-loss', 0),
    stopLossMode: value('stop-loss-mode') === 'ladder' ? 'ladder' : 'bet',
    tz: value('tz') === 'local' ? 'local' : 'utc',
    dayOffset: value('day-offset') === undefined ? null : Number(value('day-offset')) || 0,
    strict: argv.includes('--stop-loss-strict'),
  };
}

const options = parseOptions(process.argv.slice(2));
const config = loadConfig();
const store = new GameStore(config.dbPath);
const rows = store.allOrderedById();
store.close();

if (rows.length === 0) {
  logError('no games stored');
  process.exit(1);
}

const days = (Number(rows.at(-1)!.ended_at) - Number(rows[0]!.ended_at)) / 86_400_000;
const MAX_RUNGS = 40;

/** The k-th rung of the ladder, explicit or generated. */
function rung(k: number): Rung | null {
  if (options.ladder.length > 0) return options.ladder[k] ?? null;
  if (k >= MAX_RUNGS) return null;
  return { stake: options.base * options.factor ** k, target: options.target + options.step * k };
}

/** How many rungs a balance can fund in a row, and what losing them all costs. */
function affordable(balance: number): { rungs: number; cost: number } {
  let cost = 0;
  let k = 0;
  for (;;) {
    const r = rung(k);
    if (!r || cost + r.stake > balance) break;
    cost += r.stake;
    k++;
  }
  return { rungs: k, cost };
}

const openEnded = options.ladder.length === 0;
const atStart = affordable(options.balance);
const lastRung = rung(atStart.rungs - 1);

log(
  `replaying ${rows.length.toLocaleString()} games (${days.toFixed(0)} days) with ` +
    `${options.balance.toLocaleString()} bits`,
);
log(
  `trigger: a run of ${options.after}+ games under ${options.under.toFixed(2)}x ends, then ` +
    (openEnded
      ? `bet ${options.base.toLocaleString()} at ${options.target}x, ` +
        `x${options.factor} stake and +${options.step}x target after each loss, until a win`
      : `ladder ${options.ladder.map((r) => `${r.stake.toLocaleString()}@${r.target}x`).join(', ')}`),
);
log(
  `the bankroll funds ${atStart.rungs} rungs in a row; losing them all costs ` +
    `${atStart.cost.toLocaleString()} bits` +
    (lastRung ? ` (the last is ${lastRung.stake.toLocaleString()} at ${lastRung.target}x)` : ''),
);
if (options.stopLoss > 0) {
  const dayLabel =
    options.dayOffset !== null
      ? `day starting ${String(options.dayOffset).padStart(2, '0')}:00 UTC`
      : `${options.tz.toUpperCase()} day`;
  log(
    `daily stop-loss ${options.stopLoss.toLocaleString()} bits per ${dayLabel}, ` +
      (options.stopLossMode === 'bet'
        ? 'checked before every bet (a ladder in progress is abandoned)'
        : 'checked only before starting a ladder (a started ladder runs on)') +
      (options.strict ? '; strict: no bet may take the day past the limit' : ''),
  );
}

let balance = options.balance;
let peak = balance;
let peakAt: { id: number; at: number; trigger: number } | null = null;
let maxDrawdown = 0;
let run = 0;
let triggers = 0;
let skippedUnfunded = 0;
let skippedStopped = 0;
let abandoned = 0;
let wagered = 0;
let deepestRung = 0;
let biggestLoss = 0;
/** Rung index each trigger was won on; -1 when the ladder ran out; -2 when the stop-loss cut it. */
const outcomes = new Map<number, number>();
const rungAttempts: number[] = [];
const rungWins: number[] = [];
const monthly = new Map<string, number>();
let firstUnfunded: { id: number; at: number } | null = null;

// Daily accounting for the stop-loss.
let currentDay = '';
let dayPnl = 0;
let dayStopped = false;
const dayResults: number[] = [];
let daysStopped = 0;
let daysActive = 0;
let dayHadBet = false;

function dayOf(ms: number): string {
  if (options.dayOffset !== null) return dayKey(ms + options.dayOffset * 3_600_000, 'utc');
  return dayKey(ms, options.tz);
}

function rollDay(ms: number): void {
  const key = dayOf(ms);
  if (key === currentDay) return;
  if (currentDay !== '' && dayHadBet) {
    dayResults.push(dayPnl);
    daysActive++;
    if (dayStopped) daysStopped++;
  }
  currentDay = key;
  dayPnl = 0;
  dayStopped = false;
  dayHadBet = false;
}

function stopHit(): boolean {
  return options.stopLoss > 0 && -dayPnl >= options.stopLoss;
}

for (let i = 0; i < rows.length; i++) {
  const game = rows[i]!;
  rollDay(Number(game.ended_at));
  const month = new Date(Number(game.ended_at)).toISOString().slice(0, 7);
  if (!monthly.has(month)) monthly.set(month, balance);

  if (game.bust < options.under) {
    run++;
    continue;
  }

  // A game at or above the threshold ends the run. Long enough to act on?
  const runLength = run;
  const qualifies = run >= options.after;
  run = 0;
  if (!qualifies) continue;

  if (stopHit()) {
    skippedStopped++;
    dayStopped = true;
    continue;
  }

  const first = rung(0);
  if (!first || balance < first.stake) {
    skippedUnfunded++;
    if (firstUnfunded === null) firstUnfunded = { id: game.id, at: Number(game.ended_at) };
    continue;
  }

  triggers++;
  const balanceBefore = balance;
  let won = false;
  let cut = false;
  let consumed = 0;
  let staked = 0;
  for (let k = 0; i + 1 + k < rows.length; k++) {
    const r = rung(k);
    // The ladder ends when the next stake cannot be placed.
    if (!r || r.stake > balance) break;
    const next = rows[i + 1 + k]!;
    // Judge the stop against the day the losses so far were booked on, so a
    // ladder that has already overrun the limit is cut even if its next bet
    // would fall on a fresh day. Then roll the day for the bet itself.
    if (options.stopLossMode === 'bet' && stopHit()) {
      cut = true;
      dayStopped = true;
      break;
    }
    rollDay(Number(next.ended_at));
    const wouldOvershoot =
      options.strict && options.stopLoss > 0 && dayPnl - r.stake < -options.stopLoss;
    if (options.stopLossMode === 'bet' && wouldOvershoot) {
      cut = true;
      dayStopped = true;
      break;
    }
    consumed++;
    dayHadBet = true;
    rungAttempts[k] = (rungAttempts[k] ?? 0) + 1;
    wagered += r.stake;
    staked += r.stake;
    if (k + 1 > deepestRung) deepestRung = k + 1;
    if (next.bust >= r.target) {
      const gain = r.stake * (r.target - 1);
      balance += gain;
      dayPnl += gain;
      rungWins[k] = (rungWins[k] ?? 0) + 1;
      outcomes.set(k, (outcomes.get(k) ?? 0) + 1);
      won = true;
      break;
    }
    balance -= r.stake;
    dayPnl -= r.stake;
  }
  if (!won) {
    if (cut) {
      abandoned++;
      outcomes.set(-2, (outcomes.get(-2) ?? 0) + 1);
    } else {
      outcomes.set(-1, (outcomes.get(-1) ?? 0) + 1);
    }
    if (staked > biggestLoss) biggestLoss = staked;
  }

  if (options.trace) {
    const net = balance - balanceBefore;
    const when = new Date(Number(game.ended_at)).toISOString().slice(0, 16).replace('T', ' ');
    const how = won
      ? `won on rung ${consumed}`
      : cut
        ? `STOPPED by daily limit after ${consumed} rungs`
        : `FAILED after ${consumed} rungs`;
    console.log(
      `  ${String(triggers).padStart(3)}  ${when}  run of ${String(runLength).padStart(2)} ended at #${game.id}, ` +
        `ladder from #${game.id + 1}: ${how}, ` +
        `${net >= 0 ? '+' : ''}${Math.round(net).toLocaleString()}  balance ${Math.round(balance).toLocaleString()}`,
    );
  }

  // The ladder's games were played, but a live observer still watches them.
  // A win ends on a game at or above 2x, so the run restarts; a failed ladder
  // may have ended on games under 2x, which count towards the next run.
  run = 0;
  for (let k = consumed; k >= 1; k--) {
    if (rows[i + k]!.bust < options.under) run++;
    else break;
  }
  i += consumed;

  if (balance > peak) {
    peak = balance;
    peakAt = { id: game.id, at: Number(game.ended_at), trigger: triggers };
  }
  if (peak - balance > maxDrawdown) maxDrawdown = peak - balance;
}
// Close the final day.
if (dayHadBet) {
  dayResults.push(dayPnl);
  daysActive++;
  if (dayStopped) daysStopped++;
}

const profit = balance - options.balance;
const failed = outcomes.get(-1) ?? 0;
const opportunities = triggers + skippedUnfunded + skippedStopped;

console.log('');
console.log('RESULT OVER THIS DATA');
console.log(`  runs of ${options.after}+ that ended  ${opportunities.toLocaleString()}   (each one is a chance to play the ladder once)`);
console.log(`  ladders played      ${triggers.toLocaleString()}`);
if (skippedStopped > 0) {
  console.log(`  ladders not started ${skippedStopped.toLocaleString()}   (daily stop-loss already hit)`);
}
if (skippedUnfunded > 0) {
  console.log(`  ladders skipped     ${skippedUnfunded.toLocaleString()}   (no money left to place even the first bet)`);
}
console.log(`  total wagered       ${wagered.toLocaleString()} bits`);
console.log(`  final balance       ${Math.round(balance).toLocaleString()} bits`);
console.log(`  profit              ${profit >= 0 ? '+' : ''}${Math.round(profit).toLocaleString()} bits (${(profit / 1_000_000).toFixed(3)} BTC)`);
if (peakAt) {
  console.log(
    `  peak balance        ${Math.round(peak).toLocaleString()} bits after trigger ${peakAt.trigger} ` +
      `on ${new Date(peakAt.at).toISOString().slice(0, 10)}`,
  );
}
console.log(`  max drawdown        ${Math.round(maxDrawdown).toLocaleString()} bits`);
console.log(`  ladders that failed ${failed}  (worst single loss ${biggestLoss.toLocaleString()})`);
if (abandoned > 0) console.log(`  ladders cut by stop ${abandoned}`);
if (skippedUnfunded > 0 && firstUnfunded) {
  console.log(
    `  BANKRUPT            from ${new Date(firstUnfunded.at).toISOString().slice(0, 10)} (game #${firstUnfunded.id}); ` +
      `every later run was seen but could not be played`,
  );
}

if (options.stopLoss > 0 && dayResults.length > 0) {
  const sorted = [...dayResults].sort((a, b) => a - b);
  const winning = dayResults.filter((d) => d > 0).length;
  const losing = dayResults.filter((d) => d < 0).length;
  const avg = dayResults.reduce((a, b) => a + b, 0) / dayResults.length;
  console.log('');
  console.log('  by day');
  console.log(`    days with a bet          ${daysActive}`);
  console.log(`    days that hit the stop   ${daysStopped}`);
  console.log(`    winning / losing days    ${winning} / ${losing}`);
  console.log(`    average day              ${avg >= 0 ? '+' : ''}${Math.round(avg).toLocaleString()}`);
  console.log(`    best day                 +${Math.round(sorted.at(-1)!).toLocaleString()}`);
  console.log(`    worst day                ${Math.round(sorted[0]!).toLocaleString()}`);
}

console.log('');
console.log('  how each trigger ended');
let priorStake = 0;
for (let k = 0; k < deepestRung; k++) {
  const r = rung(k)!;
  const net = r.stake * (r.target - 1) - priorStake;
  const n = outcomes.get(k) ?? 0;
  console.log(
    `    won on rung ${String(k + 1).padStart(2)} (${r.stake.toLocaleString().padStart(9)} @ ${String(r.target).padEnd(4)}x)  ` +
      `${String(n).padStart(4)}  ${((n / triggers) * 100).toFixed(1).padStart(5)}%   each +${net.toLocaleString()}`,
  );
  priorStake += r.stake;
}
if (abandoned > 0) {
  console.log(
    `    cut short by the daily stop-loss           ${String(abandoned).padStart(4)}  ` +
      `${((abandoned / triggers) * 100).toFixed(1).padStart(5)}%`,
  );
}
console.log(
  `    ladder failed, bankroll ran out            ${String(failed).padStart(4)}  ` +
    `${((failed / triggers) * 100).toFixed(1).padStart(5)}%`,
);

console.log('');
console.log('  does a long run make the next game more likely to pay?');
console.log('    rung  target   won after a run      any game (fair)');
for (let k = 0; k < deepestRung; k++) {
  const r = rung(k)!;
  const attempts = rungAttempts[k] ?? 0;
  const observed = attempts > 0 ? ((rungWins[k] ?? 0) / attempts) * 100 : NaN;
  console.log(
    `    ${String(k + 1).padStart(2)}    ${String(r.target).padEnd(4)}x   ${observed.toFixed(1).padStart(5)}%  (${String(attempts).padStart(4)} bets)   ` +
      `${(expectedShareAtLeast(r.target) * 100).toFixed(1)}%`,
  );
}

console.log('');
console.log('  balance at the start of each month');
for (const [month, value] of monthly) {
  console.log(`    ${month}  ${Math.round(value).toLocaleString().padStart(11)}`);
}

// Fair-game prediction for the ladder the starting bankroll can fund. Games are
// independent, so the run before the ladder changes nothing about its odds.
let reach = 1;
let evPerTrigger = 0;
let expectedWager = 0;
let prior = 0;
for (let k = 0; k < atStart.rungs; k++) {
  const r = rung(k)!;
  const pWin = expectedShareAtLeast(r.target);
  expectedWager += reach * r.stake;
  evPerTrigger += reach * pWin * (r.stake * (r.target - 1) - prior);
  prior += r.stake;
  reach *= 1 - pWin;
}
evPerTrigger -= reach * atStart.cost;
const p = expectedShareBelow(options.under);
const triggersPerYear = ((rows.length / days) * 365) * Math.pow(p, options.after) * (1 - p);

console.log('');
console.log('WHAT A FAIR GAME PREDICTS FOR THIS STRATEGY' + (options.stopLoss > 0 ? ' (without the stop-loss)' : ''));
console.log(`  triggers per year               ${Math.round(triggersPerYear).toLocaleString()}`);
console.log(`  chance a ladder fails outright  ${(reach * 100).toFixed(1)}%  (1 in ${Math.round(1 / reach)})`);
console.log(`  expected such failures per year ${(reach * triggersPerYear).toFixed(1)}, each -${atStart.cost.toLocaleString()}`);
console.log(`  expected wager per trigger      ${Math.round(expectedWager).toLocaleString()} bits`);
console.log(`  expected value per trigger      ${Math.round(evPerTrigger).toLocaleString()} bits  (${((evPerTrigger / expectedWager) * 100).toFixed(2)}% of wager)`);
console.log(`  expected value per year         ${Math.round(evPerTrigger * triggersPerYear).toLocaleString()} bits`);
