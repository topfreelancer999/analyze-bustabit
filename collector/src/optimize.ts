import { writeFileSync } from 'node:fs';
import { loadConfig, log, logError } from './config.ts';
import { GameStore } from './db.ts';
import { describeConfig, replayStrategy, type GameLite, type StrategyConfig } from './strategy.ts';

/**
 * Searches the space of bots this project has explored for the one that did
 * best, then checks whether that success survives on data it was not chosen on.
 *
 * The data is split by date. Every combination is replayed on the training
 * period and ranked. The top ranks are then replayed on the later test period,
 * starting fresh with the same bankroll. If a bot has a real edge its test
 * result should look like its training result. If it was fitted to noise, the
 * two will be unrelated.
 *
 * Usage:
 *   npm run optimize                       # split at 2026-06-01
 *   npm run optimize -- --split 2026-05-01 --balance 2000000 --top 15
 */

interface Options {
  balance: number;
  split: string;
  top: number;
  csv: string;
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
    split: value('split') ?? '2026-06-01',
    top: Math.floor(number('top', 12)),
    csv: value('csv') ?? 'data/optimize.csv',
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

const games: GameLite[] = rows.map((r) => ({ id: r.id, bust: r.bust, endedAt: Number(r.ended_at) }));
const splitMs = Date.parse(`${options.split}T00:00:00Z`);
if (!Number.isFinite(splitMs)) {
  logError(`bad --split date: ${options.split}`);
  process.exit(1);
}
const train = games.filter((g) => g.endedAt < splitMs);
const test = games.filter((g) => g.endedAt >= splitMs);
if (train.length < 10_000 || test.length < 10_000) {
  logError('the split leaves too little data on one side');
  process.exit(1);
}
const daysOf = (g: GameLite[]) => (g.at(-1)!.endedAt - g[0]!.endedAt) / 86_400_000;

log(
  `train: ${train.length.toLocaleString()} games, ${daysOf(train).toFixed(0)} days ` +
    `(${new Date(train[0]!.endedAt).toISOString().slice(0, 10)} to ${options.split})`,
);
log(
  `test:  ${test.length.toLocaleString()} games, ${daysOf(test).toFixed(0)} days ` +
    `(${options.split} to ${new Date(test.at(-1)!.endedAt).toISOString().slice(0, 10)})`,
);

// The grid: every combination of the ideas explored so far.
const grid: StrategyConfig[] = [];
for (const after of [0, 8, 10, 12, 15]) {
  for (const base of [1_000, 10_000, 50_000]) {
    for (const target of [1.5, 2, 3]) {
      for (const step of [0, 0.5]) {
        for (const stopLoss of [0, 40_000, 80_000, 200_000]) {
          for (const strict of stopLoss === 0 ? [false] : [false, true]) {
            grid.push({
              balance: options.balance,
              after,
              under: 2,
              base,
              factor: 2,
              target,
              step,
              stopLoss,
              strict,
              dayOffset: 0,
            });
          }
        }
      }
    }
  }
}
log(`grid: ${grid.length} bots`);

interface Scored {
  cfg: StrategyConfig;
  train: ReturnType<typeof replayStrategy>;
  test: ReturnType<typeof replayStrategy>;
}

const started = Date.now();
const scored: Scored[] = grid.map((cfg) => ({
  cfg,
  train: replayStrategy(train, cfg),
  test: replayStrategy(test, cfg),
}));
log(`replayed ${grid.length * 2} runs in ${((Date.now() - started) / 1000).toFixed(1)}s`);

const fmt = (n: number) => `${n >= 0 ? '+' : ''}${Math.round(n).toLocaleString()}`;
const pad = (s: string, w: number) => s.padStart(w);

// Ranked on training only, as a real optimizer would be.
const byTrain = [...scored].sort((a, b) => b.train.profit - a.train.profit);

console.log('');
console.log(`TOP ${options.top} ON THE TRAINING PERIOD, then what each did on the test period`);
console.log('');
console.log(
  `  ${'#'.padStart(2)}  ${'train'.padStart(11)}  ${'test'.padStart(11)}  ${'test bankrupt'.padEnd(13)}  bot`,
);
byTrain.slice(0, options.top).forEach((s, i) => {
  const bk = s.test.bankruptAt ? new Date(s.test.bankruptAt).toISOString().slice(0, 10) : '-';
  console.log(
    `  ${pad(String(i + 1), 2)}  ${pad(fmt(s.train.profit), 11)}  ${pad(fmt(s.test.profit), 11)}  ${bk.padEnd(13)}  ${describeConfig(s.cfg)}`,
  );
});

const trainWinners = scored.filter((s) => s.train.profit > 0);
const testWinners = scored.filter((s) => s.test.profit > 0);
const both = scored.filter((s) => s.train.profit > 0 && s.test.profit > 0);
const topTestProfits = byTrain.slice(0, options.top).map((s) => s.test.profit);
const topTestMean = topTestProfits.reduce((a, b) => a + b, 0) / topTestProfits.length;

console.log('');
console.log('ACROSS THE WHOLE GRID');
console.log(`  bots profitable on train           ${trainWinners.length} of ${grid.length}`);
console.log(`  bots profitable on test            ${testWinners.length} of ${grid.length}`);
console.log(`  profitable on both                 ${both.length} of ${grid.length}`);
console.log(`  top ${options.top} by train: average test  ${fmt(topTestMean)}`);
console.log(`  top ${options.top} by train: test winners  ${topTestProfits.filter((p) => p > 0).length} of ${options.top}`);

// Does doing well on train predict doing well on test?
const xs = scored.map((s) => s.train.profit);
const ys = scored.map((s) => s.test.profit);
const mean = (a: number[]) => a.reduce((p, q) => p + q, 0) / a.length;
const mx = mean(xs);
const my = mean(ys);
let cov = 0;
let vx = 0;
let vy = 0;
for (let i = 0; i < xs.length; i++) {
  cov += (xs[i]! - mx) * (ys[i]! - my);
  vx += (xs[i]! - mx) ** 2;
  vy += (ys[i]! - my) ** 2;
}
const corr = cov / Math.sqrt(vx * vy);
console.log(`  correlation, train vs test profit  ${corr.toFixed(3)}   (1 = past success predicts future, 0 = no relation)`);

// What the house edge predicts for each bot: minus 1% of what it wagered.
const evGap = scored.map((s) => (s.train.profit + s.test.profit) - -0.01 * (s.train.wagered + s.test.wagered));
console.log(
  `  realised vs 1% of wagered, whole year  average gap ${fmt(mean(evGap))} across ${grid.length} bots`,
);

// Bots that survived both periods without bankruptcy, ranked by combined result.
const survivors = scored
  .filter((s) => s.train.bankruptAt === null && s.test.bankruptAt === null)
  .sort((a, b) => b.train.profit + b.test.profit - (a.train.profit + a.test.profit));
console.log('');
console.log(`SURVIVED BOTH PERIODS WITHOUT GOING BANKRUPT: ${survivors.length} of ${grid.length}`);
console.log(`  best combined result among them:`);
survivors.slice(0, 5).forEach((s) => {
  console.log(
    `    ${pad(fmt(s.train.profit + s.test.profit), 11)}  (train ${fmt(s.train.profit)}, test ${fmt(s.test.profit)}, ` +
      `wagered ${Math.round(s.train.wagered + s.test.wagered).toLocaleString()})  ${describeConfig(s.cfg)}`,
  );
});

const header =
  'after,under,base,factor,target,step,stop_loss,strict,train_profit,train_wagered,train_bankrupt,test_profit,test_wagered,test_bankrupt';
const lines = scored.map((s) =>
  [
    s.cfg.after, s.cfg.under, s.cfg.base, s.cfg.factor, s.cfg.target, s.cfg.step, s.cfg.stopLoss, s.cfg.strict,
    Math.round(s.train.profit), Math.round(s.train.wagered), s.train.bankruptAt ? new Date(s.train.bankruptAt).toISOString().slice(0, 10) : '',
    Math.round(s.test.profit), Math.round(s.test.wagered), s.test.bankruptAt ? new Date(s.test.bankruptAt).toISOString().slice(0, 10) : '',
  ].join(','),
);
writeFileSync(options.csv, `${header}\n${lines.join('\n')}\n`, 'utf8');
console.log('');
log(`wrote every bot's result to ${options.csv}`);
