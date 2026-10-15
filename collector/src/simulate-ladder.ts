import { loadConfig, log, logError } from './config.ts';
import { GameStore } from './db.ts';
import { expectedShareAtLeast } from '../../shared/expected.ts';

/**
 * Replays a "rising ladder" bot over every stored game, continuously.
 *
 * Rung n stakes `base * n` at `(start + (n - 1) * step)`x: 1 at 2x, 2 at 3x,
 * 3 at 4x, ... A win goes back to rung 1; a loss moves up one rung. Any win
 * at rung n nets n(n+1)/2 stakes over the whole ladder, so every finished
 * ladder is a profit. The risk is the ladder that never finishes.
 *
 * When the balance cannot cover the next rung, the ladder is lost. If the
 * balance then cannot cover rung 1 either, the bot is bankrupt; with
 * `--refill` it is topped back up to the starting balance and counted.
 *
 * Usage:
 *   npm run simulate:ladder
 *   npm run simulate:ladder -- --base 1 --balance 2000000 --refill
 */

interface Options {
  balance: number;
  base: number;
  start: number;
  step: number;
  refill: boolean;
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
    base: number('base', 1),
    start: number('start', 2),
    step: number('step', 1),
    refill: argv.includes('--refill'),
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
const targetAt = (n: number) => options.start + (n - 1) * options.step;
const stakeAt = (n: number) => options.base * n;

log(`replaying ${rows.length.toLocaleString()} games (${days.toFixed(0)} days) with ${options.balance.toLocaleString()} bits`);
log(
  `rung n bets ${options.base} x n at ${options.start} + ${options.step}(n-1) x: ` +
    [1, 2, 3, 4].map((n) => `${stakeAt(n)}@${targetAt(n)}x`).join(', ') + ', ...',
);

// Deepest rung the starting balance can reach, and the chance a ladder gets there.
let deepest = 0;
let cost = 0;
while (cost + stakeAt(deepest + 1) <= options.balance) cost += stakeAt(++deepest);
let reach = 1;
for (let n = 1; n <= deepest; n++) reach *= 1 - expectedShareAtLeast(targetAt(n));
log(
  `a full balance covers ${deepest} rungs (${cost.toLocaleString()} bits); ` +
    `fair chance a ladder loses all of them: 1 in ${Math.round(1 / reach).toLocaleString()}`,
);

let balance = options.balance;
let peak = balance;
let maxDrawdown = 0;
let wagered = 0;
let bets = 0;
let ladders = 0;
let laddersWon = 0;
let laddersLost = 0;
let refills = 0;
let bankruptAt: number | null = null;
let rung = 1;
let ladderCost = 0;
let ladderStartedAt = 0;
const deepestWins: Array<{ rung: number; at: number }> = [];
const losses: Array<{ rungs: number; cost: number; at: number }> = [];
const rungCounts = new Map<number, number>();
const monthly = new Map<string, number>();

for (let i = 0; i < rows.length; i++) {
  const game = rows[i]!;
  const at = Number(game.ended_at);
  const month = new Date(at).toISOString().slice(0, 7);
  if (!monthly.has(month)) monthly.set(month, balance - refills * options.balance);

  if (rung === 1) {
    if (balance < stakeAt(1)) {
      bankruptAt ??= at;
      if (!options.refill) break;
      refills++;
      balance += options.balance;
    }
    ladders++;
    ladderCost = 0;
    ladderStartedAt = at;
  }

  const stake = stakeAt(rung);
  if (stake > balance) {
    // Cannot place the next rung: the ladder is lost as it stands.
    laddersLost++;
    losses.push({ rungs: rung - 1, cost: ladderCost, at: ladderStartedAt });
    rung = 1;
    i--; // this game starts the next ladder
    continue;
  }

  const target = targetAt(rung);
  wagered += stake;
  bets++;
  if (game.bust >= target) {
    balance += stake * (target - 1);
    laddersWon++;
    rungCounts.set(rung, (rungCounts.get(rung) ?? 0) + 1);
    deepestWins.push({ rung, at: ladderStartedAt });
    rung = 1;
  } else {
    balance -= stake;
    ladderCost += stake;
    rung++;
  }

  const net = balance - refills * options.balance;
  if (net > peak) peak = net;
  if (peak - net > maxDrawdown) maxDrawdown = peak - net;
}

const net = balance - options.balance - refills * options.balance;
const fmt = (n: number) => `${n >= 0 ? '+' : ''}${Math.round(n).toLocaleString()}`;

console.log('');
console.log('RESULT OVER THIS DATA');
console.log(`  bets placed         ${bets.toLocaleString()}`);
console.log(`  ladders             ${ladders.toLocaleString()}   won ${laddersWon.toLocaleString()}, lost ${laddersLost}`);
console.log(`  total wagered       ${Math.round(wagered).toLocaleString()} bits`);
console.log(`  house edge on wager ${fmt(-0.01 * wagered)} bits   (1% of what was bet)`);
console.log(`  net profit          ${fmt(net)} bits`);
console.log(`  max drawdown        ${Math.round(maxDrawdown).toLocaleString()} bits`);
if (bankruptAt !== null) {
  console.log(`  first bankruptcy    ${new Date(bankruptAt).toISOString().slice(0, 16).replace('T', ' ')}`);
}
if (options.refill) console.log(`  refills             ${refills}   (each ${options.balance.toLocaleString()} bits)`);

const sortedWins = [...deepestWins].sort((a, b) => b.rung - a.rung).slice(0, 5);
console.log('');
console.log('  deepest ladders that still won');
for (const w of sortedWins) {
  const paid = (w.rung * (w.rung + 1)) / 2 * options.base;
  console.log(`    rung ${String(w.rung).padStart(5)}  ${new Date(w.at).toISOString().slice(0, 16).replace('T', ' ')}  nets +${paid.toLocaleString()}`);
}
if (losses.length > 0) {
  console.log('');
  console.log(`  ladders lost (ran out of balance): ${losses.length}, the ten costliest`);
  for (const l of [...losses].sort((a, b) => b.cost - a.cost).slice(0, 10)) {
    console.log(`    ${l.rungs} rungs  ${new Date(l.at).toISOString().slice(0, 16).replace('T', ' ')}  cost ${Math.round(l.cost).toLocaleString()}`);
  }
}

console.log('');
console.log('  where ladders finished   observed vs fair');
const buckets: Array<[number, number]> = [[1, 1], [2, 2], [3, 5], [6, 10], [11, 50], [51, 200], [201, 1000], [1001, 1e9]];
for (const [lo, hi] of buckets) {
  let observed = 0;
  for (const [r, c] of rungCounts) if (r >= lo && r <= hi) observed += c;
  let fair = 0;
  let survive = 1;
  for (let n = 1; n <= Math.min(hi, deepest); n++) {
    const p = expectedShareAtLeast(targetAt(n));
    if (n >= lo) fair += survive * p;
    survive *= 1 - p;
  }
  const label = lo === hi ? `rung ${lo}` : `rungs ${lo}-${hi > 1e8 ? '' : hi}`;
  console.log(
    `    ${label.padEnd(16)} ${((observed / ladders) * 100).toFixed(2).padStart(6)}%  ${(fair * 100).toFixed(2).padStart(6)}%`,
  );
}

console.log('');
console.log('  net at the start of each month');
for (const [month, value] of monthly) {
  console.log(`    ${month}  ${fmt(value - options.balance).padStart(11)}`);
}
