import { loadConfig, log, logError } from './config.ts';
import { GameStore } from './db.ts';
import { expectedShareAtLeast } from '../../shared/expected.ts';

/**
 * Replays a timed "quiet window" bot over the stored games.
 *
 * Every `--every` minutes (on the clock: :00, :05, :10, ...) the bot looks at
 * the last `--look` busts. If none reached `--above`, it places one bet of
 * `--stake` at `--target` on the next game. Otherwise it skips the cycle.
 *
 * Usage:
 *   npm run simulate:interval
 *   npm run simulate:interval -- --every 5 --look 50 --above 25 --stake 1000 --target 20
 */

interface Options {
  balance: number;
  everyMin: number;
  look: number;
  above: number;
  stake: number;
  target: number;
}

function parseOptions(argv: string[]): Options {
  const value = (name: string): string | undefined => {
    const index = argv.indexOf(`--${name}`);
    if (index >= 0 && argv[index + 1]) return argv[index + 1];
    return argv.find((a) => a.startsWith(`--${name}=`))?.split('=')[1];
  };
  const number = (name: string, fallback: number): number => {
    const parsed = Number(value(name));
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
  };
  return {
    balance: number('balance', 2_000_000),
    everyMin: number('every', 5),
    look: Math.floor(number('look', 50)),
    above: number('above', 25),
    stake: number('stake', 1000),
    target: number('target', 20),
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
const pWin = expectedShareAtLeast(options.target);
const pQuiet = (1 - expectedShareAtLeast(options.above)) ** options.look;
const periodMs = options.everyMin * 60_000;

log(`replaying ${rows.length.toLocaleString()} games (${days.toFixed(0)} days) with ${options.balance.toLocaleString()} bits`);
log(
  `every ${options.everyMin} min: if none of the last ${options.look} busts reached ${options.above}x, ` +
    `bet ${options.stake.toLocaleString()} at ${options.target}x once, else skip`,
);
log(
  `fair game: the window is quiet ${(pQuiet * 100).toFixed(1)}% of the time, ` +
    `and a ${options.target}x bet wins ${(pWin * 100).toFixed(2)}%`,
);

let balance = options.balance;
let peak = balance;
let maxDrawdown = 0;
let cycles = 0;
let skipped = 0;
let bets = 0;
let wins = 0;
let longestLosing = 0;
let losing = 0;
let bankruptAt: number | null = null;
const monthly = new Map<string, { start: number; bets: number; wins: number }>();
/** Index of the most recent game at or above `above`. */
let lastBig = -Infinity;
let currentPeriod = Math.floor(Number(rows[0]!.ended_at) / periodMs);

for (let i = 0; i < rows.length; i++) {
  const at = Number(rows[i]!.ended_at);
  const period = Math.floor(at / periodMs);
  const month = new Date(at).toISOString().slice(0, 7);
  if (!monthly.has(month)) monthly.set(month, { start: balance, bets: 0, wins: 0 });

  // Game i is the one in flight when the clock passes the boundary: the bot
  // sees only the games before it and can first bet on game i + 1. Betting on
  // game i itself would be look-ahead, and a biased one, since a clock tick is
  // more likely to fall inside a long flight, and long flights are high busts.
  if (period !== currentPeriod) {
    currentPeriod = period;
    if (i >= options.look && i + 1 < rows.length) {
      cycles++;
      if (lastBig >= i - options.look) {
        skipped++;
      } else if (balance < options.stake) {
        bankruptAt ??= at;
      } else {
        bets++;
        monthly.get(month)!.bets++;
        if (rows[i + 1]!.bust >= options.target) {
          balance += options.stake * (options.target - 1);
          wins++;
          monthly.get(month)!.wins++;
          losing = 0;
        } else {
          balance -= options.stake;
          losing++;
          if (losing > longestLosing) longestLosing = losing;
        }
        if (balance > peak) peak = balance;
        if (peak - balance > maxDrawdown) maxDrawdown = peak - balance;
      }
    }
  }
  if (rows[i]!.bust >= options.above) lastBig = i;
}

const profit = balance - options.balance;
const wagered = bets * options.stake;
const expected = bets * options.stake * (pWin * options.target - 1);
const sd = Math.sqrt(bets * pWin * (1 - pWin)) * options.stake * options.target;
const z = (profit - expected) / sd;
const hitSd = Math.sqrt(bets * pWin * (1 - pWin));
const fmt = (n: number) => `${n >= 0 ? '+' : ''}${Math.round(n).toLocaleString()}`;

console.log('');
console.log('RESULT OVER THIS DATA');
console.log(`  5-minute checks     ${cycles.toLocaleString()}`);
console.log(`  skipped             ${skipped.toLocaleString()}   (a ${options.above}x+ was in the last ${options.look})`);
console.log(`  bets placed         ${bets.toLocaleString()}   (${((bets / cycles) * 100).toFixed(1)}% of checks, fair ${(pQuiet * 100).toFixed(1)}%)`);
console.log(
  `  wins                ${wins.toLocaleString()}   (${((wins / bets) * 100).toFixed(2)}%, fair ${(pWin * 100).toFixed(2)}% ` +
    `= ${Math.round(bets * pWin).toLocaleString()} ± ${Math.round(hitSd)})`,
);
console.log(`  total wagered       ${wagered.toLocaleString()} bits`);
console.log(`  final balance       ${Math.round(balance).toLocaleString()} bits`);
console.log(`  profit              ${fmt(profit)} bits`);
console.log(`  expected profit     ${fmt(expected)} bits   (1 sd ±${Math.round(sd).toLocaleString()}, z = ${z.toFixed(2)})`);
console.log(`  max drawdown        ${Math.round(maxDrawdown).toLocaleString()} bits`);
console.log(`  longest losing run  ${longestLosing} bets (${(longestLosing * options.stake).toLocaleString()} bits)`);
if (bankruptAt !== null) console.log(`  ran out of funds    ${new Date(bankruptAt).toISOString().slice(0, 16)}`);

console.log('');
console.log('  month      start balance   bets   wins   win %');
for (const [month, m] of monthly) {
  console.log(
    `    ${month}  ${Math.round(m.start).toLocaleString().padStart(11)}  ${String(m.bets).padStart(5)}  ${String(m.wins).padStart(5)}  ` +
      `${m.bets ? ((m.wins / m.bets) * 100).toFixed(2).padStart(6) : '     -'}%`,
  );
}
