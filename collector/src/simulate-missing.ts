import { loadConfig, log, logError } from './config.ts';
import { GameStore } from './db.ts';
import { expectedShareAtLeast } from '../../shared/expected.ts';

/**
 * Replays a "missing multiplier" bot over the stored games.
 *
 * At each checkpoint the bot looks back over a family of windows: the last 70
 * rounds for a 10x, the last 140 for a 20x, ... the last 700 for a 100x. Each
 * window is sized so a fair game puts about seven hits in it. If a window has
 * none, the bot bets a fixed stake on that target for up to `--rounds` games,
 * stopping at the first win, then goes back to checking.
 *
 * The stake never changes, so this cannot bust out the way a ladder does. What
 * it tests is whether a target that has gone missing is more likely to appear.
 *
 * Usage:
 *   npm run simulate:missing
 *   npm run simulate:missing -- --stake 100 --rounds 20 --pick lowest
 *   npm run simulate:missing -- --rounds target      # bet for as many rounds as the target
 */

interface Options {
  balance: number;
  stake: number;
  /** How long to bet per activation: a fixed count, the target value, or the window width. */
  roundsMode: 'fixed' | 'target' | 'window';
  rounds: number;
  /** Number of windows: k = 1..windows, each 70k rounds wide looking for 10k x. */
  windows: number;
  windowUnit: number;
  targetUnit: number;
  /** Which target to bet when several are missing at once. */
  pick: 'lowest' | 'highest';
  /** Minutes to sit out after a win before checking again. */
  cooldownMin: number;
  trace: boolean;
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
    stake: number('stake', 100),
    roundsMode:
      value('rounds') === 'target' ? 'target' : value('rounds') === 'window' ? 'window' : 'fixed',
    rounds: Math.floor(number('rounds', 20)),
    windows: Math.floor(number('windows', 10)),
    windowUnit: Math.floor(number('window-unit', 70)),
    targetUnit: number('target-unit', 10),
    pick: value('pick') === 'highest' ? 'highest' : 'lowest',
    cooldownMin: Number(value('cooldown') ?? 0) || 0,
    trace: argv.includes('--trace'),
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
const targets = Array.from({ length: options.windows }, (_, i) => (i + 1) * options.targetUnit);
const widths = Array.from({ length: options.windows }, (_, i) => (i + 1) * options.windowUnit);
const roundsFor = (k: number) =>
  options.roundsMode === 'fixed'
    ? options.rounds
    : options.roundsMode === 'target'
      ? Math.round(targets[k]!)
      : widths[k]!;

log(`replaying ${rows.length.toLocaleString()} games (${days.toFixed(0)} days) with ${options.balance.toLocaleString()} bits`);
log(
  `windows: ${targets.map((t, i) => `${t}x in ${widths[i]}`).join(', ')}` +
    ` (each expects ${(widths[0]! * expectedShareAtLeast(targets[0]!)).toFixed(2)} hits)`,
);
if (options.cooldownMin > 0) {
  log(`after a win the bot sits out ${options.cooldownMin} minute(s) before checking again`);
}
log(
  `when a target is missing: bet ${options.stake} at it for up to ` +
    `${options.roundsMode === 'fixed' ? options.rounds : options.roundsMode === 'target' ? 'as many rounds as the target value' : 'as many rounds as its window'} rounds, ` +
    `betting the ${options.pick} target if several are missing`,
);

// Index of the most recent game at or above each target, updated as we go.
const lastHit = new Array<number>(targets.length).fill(-1);
const noteGame = (index: number) => {
  const bust = rows[index]!.bust;
  for (let k = 0; k < targets.length; k++) if (bust >= targets[k]!) lastHit[k] = index;
};

let balance = options.balance;
let peak = balance;
let maxDrawdown = 0;
let wagered = 0;
let bets = 0;
let activations = 0;
let multiMissing = 0;
let cooldownUntil = 0;
let skippedByCooldown = 0;
/** A drought is a stretch of betting that runs until a win, across re-arms. */
let droughts = 0;
let droughtRounds = 0;
let droughtNet = 0;
let inDrought = false;
const droughtSummaries: Array<{ rounds: number; net: number; at: number }> = [];
const byTarget = targets.map(() => ({ activations: 0, wins: 0, bets: 0, profit: 0, roundsToHit: 0 }));
const monthly = new Map<string, number>();
const winAtRound: number[] = [];

const warmup = widths.at(-1)!;
for (let i = 0; i < warmup && i < rows.length; i++) noteGame(i);

for (let i = warmup; i < rows.length; i++) {
  const month = new Date(Number(rows[i]!.ended_at)).toISOString().slice(0, 7);
  if (!monthly.has(month)) monthly.set(month, balance);

  if (rows[i]!.ended_at < cooldownUntil) {
    // Sitting out after a win; the games still count towards the windows.
    skippedByCooldown++;
    noteGame(i);
    continue;
  }

  // Which targets are missing from their window ending just before this game?
  const missing: number[] = [];
  for (let k = 0; k < targets.length; k++) {
    if (lastHit[k]! < i - widths[k]!) missing.push(k);
  }
  if (missing.length === 0) {
    noteGame(i);
    continue;
  }
  if (missing.length > 1) multiMissing++;
  const k = options.pick === 'lowest' ? missing[0]! : missing.at(-1)!;
  const target = targets[k]!;
  const rounds = roundsFor(k);

  activations++;
  byTarget[k]!.activations++;
  if (!inDrought) {
    inDrought = true;
    droughtRounds = 0;
    droughtNet = 0;
  }
  const before = balance;
  let won = false;
  let played = 0;
  for (let r = 0; r < rounds && i + r < rows.length; r++) {
    if (balance < options.stake) break;
    const game = rows[i + r]!;
    noteGame(i + r);
    played++;
    bets++;
    byTarget[k]!.bets++;
    wagered += options.stake;
    if (game.bust >= target) {
      balance += options.stake * (target - 1);
      won = true;
      winAtRound.push(r + 1);
      break;
    }
    balance -= options.stake;
  }
  if (won) {
    byTarget[k]!.wins++;
    byTarget[k]!.roundsToHit += played;
  }
  byTarget[k]!.profit += balance - before;

  droughtRounds += played;
  droughtNet += balance - before;
  if (won) {
    droughts++;
    droughtSummaries.push({ rounds: droughtRounds, net: droughtNet, at: Number(rows[i]!.ended_at) });
    inDrought = false;
    if (options.cooldownMin > 0) {
      cooldownUntil = Number(rows[i + played - 1]!.ended_at) + options.cooldownMin * 60_000;
    }
  }

  if (options.trace) {
    const when = new Date(Number(rows[i]!.ended_at)).toISOString().slice(0, 16).replace('T', ' ');
    console.log(
      `  ${when}  ${target}x missing from last ${widths[k]}  bet ${played} round(s): ` +
        `${won ? `hit on round ${played}` : 'no hit'}, ${balance - before >= 0 ? '+' : ''}${Math.round(balance - before).toLocaleString()}`,
    );
  }

  i += Math.max(played, 1) - 1;
  if (balance > peak) peak = balance;
  if (peak - balance > maxDrawdown) maxDrawdown = peak - balance;
}

const profit = balance - options.balance;
const checkpoints = rows.length - warmup;

console.log('');
console.log('RESULT OVER THIS DATA');
console.log(`  checkpoints         ${checkpoints.toLocaleString()}`);
console.log(`  activations         ${activations.toLocaleString()}   (a target was missing from its window)`);
console.log(`  several missing     ${multiMissing.toLocaleString()}   (bet the ${options.pick})`);
console.log(`  bets placed         ${bets.toLocaleString()}`);
console.log(`  total wagered       ${wagered.toLocaleString()} bits`);
console.log(`  final balance       ${Math.round(balance).toLocaleString()} bits`);
console.log(`  profit              ${profit >= 0 ? '+' : ''}${Math.round(profit).toLocaleString()} bits (${(profit / 1_000_000).toFixed(3)} BTC)`);
console.log(`  house edge on wager ${Math.round(-0.01 * wagered).toLocaleString()} bits   (1% of what was bet)`);
console.log(`  max drawdown        ${Math.round(maxDrawdown).toLocaleString()} bits`);
if (options.cooldownMin > 0) {
  console.log(`  games sat out       ${skippedByCooldown.toLocaleString()}   (cooling off after a win)`);
}
if (droughtSummaries.length > 0) {
  const totalRounds = droughtSummaries.reduce((a, d) => a + d.rounds, 0);
  const worst = [...droughtSummaries].sort((a, b) => a.net - b.net)[0]!;
  console.log('');
  console.log('  seen as droughts (betting runs on through a failed attempt until a win)');
  console.log(`    droughts that ended in a win  ${droughts}`);
  console.log(`    rounds bet per drought        ${(totalRounds / droughts).toFixed(1)} average`);
  console.log(`    net per drought               ${droughtNetAvg(droughtSummaries)}`);
  console.log(
    `    worst drought                 ${Math.round(worst.net).toLocaleString()} over ${worst.rounds} rounds ` +
      `on ${new Date(worst.at).toISOString().slice(0, 10)}`,
  );
}

console.log('');
console.log('  is a missing target more likely to appear?  (win = hit within the rounds bet)');
console.log('  target  rounds  activ.   won   observed    fair    rounds to hit   pays   avg net/activation');
for (let k = 0; k < targets.length; k++) {
  const t = byTarget[k]!;
  if (t.activations === 0) continue;
  const rounds = roundsFor(k);
  const q = expectedShareAtLeast(targets[k]!);
  const fair = 1 - (1 - q) ** rounds;
  const avgRounds = t.wins > 0 ? t.roundsToHit / t.wins : NaN;
  // The observed wait is measured among wins only, so it is capped by the
  // rounds allowed; compare it with the fair wait under the same cap.
  let fairWait = 0;
  for (let j = 1; j <= rounds; j++) fairWait += j * q * (1 - q) ** (j - 1);
  fairWait /= fair;
  const avgNet = t.profit / t.activations;
  console.log(
    `  ${String(targets[k]! + 'x').padEnd(7)} ${String(rounds).padStart(5)}  ${String(t.activations).padStart(5)}  ${String(t.wins).padStart(5)}   ` +
      `${((t.wins / t.activations) * 100).toFixed(1).padStart(6)}%  ${(fair * 100).toFixed(1).padStart(6)}%   ` +
      `${avgRounds.toFixed(1).padStart(6)} (fair ${fairWait.toFixed(1)})  ${('+' + (options.stake * (targets[k]! - 1)).toLocaleString()).padStart(7)}   ` +
      `${avgNet >= 0 ? '+' : ''}${Math.round(avgNet).toLocaleString()}`,
  );
}

if (winAtRound.length > 0) {
  const avg = winAtRound.reduce((a, b) => a + b, 0) / winAtRound.length;
  console.log('');
  console.log(`  when it did hit, it took ${avg.toFixed(1)} rounds on average`);
}

function droughtNetAvg(list: Array<{ net: number }>): string {
  const avg = list.reduce((a, d) => a + d.net, 0) / list.length;
  return `${avg >= 0 ? '+' : ''}${Math.round(avg).toLocaleString()} average`;
}

console.log('');
console.log('  balance at the start of each month');
for (const [month, value] of monthly) {
  console.log(`    ${month}  ${Math.round(value).toLocaleString().padStart(11)}`);
}
