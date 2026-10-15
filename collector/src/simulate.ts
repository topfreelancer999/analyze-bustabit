import { loadConfig, log, logError } from './config.ts';
import { GameStore } from './db.ts';
import { expectedShareAtLeast } from '../../shared/expected.ts';

/**
 * Replays a doubling (Martingale) strategy over the stored games.
 *
 * The rules: bet a base amount at a fixed cashout target; after a loss double
 * the bet, after a win go back to the base. Each completed cycle nets exactly
 * one base bet, because the win repays every loss before it plus one unit.
 *
 * The strategy fails when a losing streak outlasts the balance: the next
 * doubled bet cannot be placed, and everything lost in the streak stays lost.
 * The simulation records that as a bust-out and, by default, stops there, since
 * the system as described has no rule for what to do next.
 *
 * Usage:
 *   npm run simulate -- --balance 2000000 --base 1 --target 2
 *   npm run simulate -- --balance 1000000 --continue    # restart after a bust-out
 */

interface Options {
  balance: number;
  base: number;
  target: number;
  /** Added to the cashout target after each loss in a streak; 0 keeps it fixed. */
  step: number;
  /** After a bust-out, restart the cycle with whatever balance remains. */
  continueAfterBust: boolean;
  /** Treat a bust exactly at the target as a loss rather than a win. */
  tieLoses: boolean;
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
  return {
    balance: number('balance', 2_000_000),
    base: number('base', 1),
    target: number('target', 2),
    step: Number(value('step') ?? 0) || 0,
    continueAfterBust: argv.includes('--continue'),
    tieLoses: argv.includes('--tie-loses'),
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

const first = rows[0]!;
const last = rows[rows.length - 1]!;
const days = (Number(last.ended_at) - Number(first.ended_at)) / 86_400_000;

log(
  `replaying ${rows.length.toLocaleString()} games (${days.toFixed(0)} days) with ` +
    `${options.balance.toLocaleString()} bits, base bet ${options.base}, cashout ${options.target.toFixed(2)}x` +
    (options.step > 0 ? ` rising by ${options.step}x after each loss` : '') +
    (options.tieLoses ? ' (a bust exactly at the target counts as a loss)' : ''),
);

// How many losses in a row the balance can absorb and still place the next bet.
// After k losses the streak has cost base*(2^k - 1) and the next bet is base*2^k,
// so the balance must hold base*(2^(k+1) - 1).
let survivable = 0;
while (options.base * (2 ** (survivable + 2) - 1) <= options.balance) survivable++;
const failingStreak = survivable + 1;
const lossAtFailure = options.base * (2 ** failingStreak - 1);

log(
  `the balance covers ${survivable} straight losses and the bet after them; ` +
    `a streak of ${failingStreak} loses ${lossAtFailure.toLocaleString()} bits`,
);

let balance = options.balance;
let bet = options.base;
let streak = 0;
let wins = 0;
let losses = 0;
let wagered = 0;
let peak = balance;
let maxDrawdown = 0;
let largestBet = 0;
let longestStreak = 0;
let bustOuts = 0;
let biggestWin = 0;
let stoppedAt: { id: number; at: number; index: number } | null = null;
/** The smallest gap between balance and the bet it had to place. */
let closestCall: { margin: number; id: number; at: number; bet: number } | null = null;

// Balance over time, sampled monthly for the summary.
const monthly = new Map<string, number>();

for (let i = 0; i < rows.length; i++) {
  const game = rows[i]!;
  const month = new Date(Number(game.ended_at)).toISOString().slice(0, 7);
  if (!monthly.has(month)) monthly.set(month, balance);

  if (bet > balance) {
    // The system cannot place its next bet: the streak has beaten the bankroll.
    bustOuts++;
    if (!options.continueAfterBust) {
      stoppedAt = { id: game.id, at: Number(game.ended_at), index: i };
      break;
    }
    bet = options.base;
    streak = 0;
    if (bet > balance) {
      stoppedAt = { id: game.id, at: Number(game.ended_at), index: i };
      break;
    }
  }

  wagered += bet;
  if (bet > largestBet) largestBet = bet;
  if (closestCall === null || balance - bet < closestCall.margin) {
    closestCall = { margin: balance - bet, id: game.id, at: Number(game.ended_at), bet };
  }

  const target = options.target + streak * options.step;
  const won = options.tieLoses ? game.bust > target : game.bust >= target;
  if (won) {
    balance += bet * (target - 1);
    if (bet * (target - 1) > biggestWin) biggestWin = bet * (target - 1);
    wins++;
    streak = 0;
    bet = options.base;
  } else {
    balance -= bet;
    losses++;
    streak++;
    if (streak > longestStreak) longestStreak = streak;
    bet *= 2;
  }

  if (balance > peak) peak = balance;
  const drawdown = peak - balance;
  if (drawdown > maxDrawdown) maxDrawdown = drawdown;
}

const profit = balance - options.balance;
const played = stoppedAt ? stoppedAt.index : rows.length;

console.log('');
console.log('RESULT OVER THIS DATA');
console.log(`  games played        ${played.toLocaleString()}`);
console.log(`  wins / losses       ${wins.toLocaleString()} / ${losses.toLocaleString()}`);
console.log(`  longest loss streak ${longestStreak}`);
console.log(`  largest single bet  ${largestBet.toLocaleString()} bits (${((largestBet / options.balance) * 100).toFixed(0)}% of starting balance)`);
console.log(`  biggest single win  ${Math.round(biggestWin).toLocaleString()} bits`);
console.log(`  total wagered       ${wagered.toLocaleString()} bits`);
console.log(`  final balance       ${Math.round(balance).toLocaleString()} bits`);
console.log(`  profit              ${profit >= 0 ? '+' : ''}${Math.round(profit).toLocaleString()} bits (${(profit / 1_000_000).toFixed(3)} BTC)`);
console.log(`  max drawdown        ${Math.round(maxDrawdown).toLocaleString()} bits`);
console.log(`  bust-outs           ${bustOuts}`);
if (closestCall) {
  console.log(
    `  closest call        ${Math.round(closestCall.margin).toLocaleString()} bits to spare placing ` +
      `${closestCall.bet.toLocaleString()} on game #${closestCall.id} ` +
      `(${new Date(closestCall.at).toISOString().slice(0, 16)})`,
  );
}
if (stoppedAt) {
  console.log(
    `  STOPPED at game #${stoppedAt.id} on ${new Date(stoppedAt.at).toISOString().slice(0, 16)}: ` +
      `could not place a bet of ${bet.toLocaleString()} with ${Math.round(balance).toLocaleString()} left`,
  );
}

console.log('');
console.log('  balance at the start of each month');
for (const [month, value] of monthly) {
  console.log(`    ${month}  ${Math.round(value).toLocaleString().padStart(11)}`);
}

// What the arithmetic says should happen, independent of this particular year.
// Enumerate each step of a cycle: the chance of reaching it, of winning there,
// and what that win nets after repaying the streak so far.
const targetAt = (k: number) => options.target + k * options.step;
let reach = 1;
let expectedGamesPerCycle = 0;
let evPerCycle = 0;
for (let k = 0; k < failingStreak; k++) {
  const pWinHere = expectedShareAtLeast(targetAt(k));
  const betHere = options.base * 2 ** k;
  const priorLoss = options.base * (2 ** k - 1);
  const netIfWin = betHere * (targetAt(k) - 1) - priorLoss;
  expectedGamesPerCycle += reach;
  evPerCycle += reach * pWinHere * netIfWin;
  reach *= 1 - pWinHere;
}
const pFail = reach;
evPerCycle -= pFail * lossAtFailure;
const gamesPerYear = (rows.length / days) * 365;
const cyclesPerYear = gamesPerYear / expectedGamesPerCycle;
const failuresPerYear = cyclesPerYear * pFail;

console.log('');
console.log('WHAT A FAIR GAME PREDICTS FOR THIS STRATEGY');
if (options.step > 0) {
  const last = targetAt(failingStreak - 1);
  console.log(`  cashout by the last affordable bet  ${last.toFixed(2)}x, which only ${(expectedShareAtLeast(last) * 100).toFixed(1)}% of games reach`);
}
console.log(`  chance a cycle busts out        1 in ${Math.round(1 / pFail).toLocaleString()}`);
console.log(`  cycles per year                 ${Math.round(cyclesPerYear).toLocaleString()}`);
console.log(`  expected bust-outs per year     ${failuresPerYear.toFixed(2)}`);
console.log(`  chance of a bust-out in a year  ${((1 - Math.exp(-failuresPerYear)) * 100).toFixed(0)}%`);
console.log(`  loss per bust-out               -${lossAtFailure.toLocaleString()} bits`);
console.log(`  expected value per cycle        ${evPerCycle.toFixed(3)} bits`);
console.log(`  expected value per year         ${Math.round(evPerCycle * cyclesPerYear).toLocaleString()} bits`);
