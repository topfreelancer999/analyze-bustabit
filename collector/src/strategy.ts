import { dayKey } from '../../shared/stats.ts';

/**
 * A replayable betting strategy: the family of bots explored in this project.
 *
 * Trigger: either continuous (`after` = 0, bet on every game) or wait for a run
 * of `after`+ consecutive games under `under` to end, then bet on the games
 * that follow. Ladder: stake `base`, multiplied by `factor` after each loss,
 * cashout `target` rising by `step` after each loss, until a win or until the
 * next stake cannot be placed. Optional daily stop-loss with the day boundary
 * at `dayOffset` hours from UTC midnight.
 *
 * This is a pure function of the games and the config so an optimizer can run
 * hundreds of variants in one process. The simulate-after-streak CLI has the
 * same semantics with richer reporting.
 */

export interface GameLite {
  id: number;
  bust: number;
  endedAt: number;
}

export interface StrategyConfig {
  balance: number;
  /** Run length that arms the ladder; 0 means bet continuously. */
  after: number;
  under: number;
  base: number;
  factor: number;
  target: number;
  step: number;
  /** Daily loss at which betting stops for the day; 0 disables. */
  stopLoss: number;
  /** Refuse any bet that, if lost, would take the day past the stop-loss. */
  strict: boolean;
  /** Hours from UTC midnight where the day starts. */
  dayOffset: number;
}

export interface StrategyResult {
  profit: number;
  finalBalance: number;
  peak: number;
  maxDrawdown: number;
  wagered: number;
  /** Ladder starts. */
  laddersPlayed: number;
  laddersFailed: number;
  laddersCut: number;
  /** Chances to play, including those skipped for lack of funds or the stop. */
  opportunities: number;
  daysStopped: number;
  /** Timestamp of the first opportunity that could not be funded, or null. */
  bankruptAt: number | null;
  /** Individual bets placed, and how many of them paid. */
  bets: number;
  wins: number;
  largestStake: number;
}

const MAX_RUNGS = 40;

export function replayStrategy(games: GameLite[], cfg: StrategyConfig): StrategyResult {
  let balance = cfg.balance;
  let peak = balance;
  let maxDrawdown = 0;
  let wagered = 0;
  let run = 0;
  let laddersPlayed = 0;
  let laddersFailed = 0;
  let laddersCut = 0;
  let opportunities = 0;
  let bankruptAt: number | null = null;
  let bets = 0;
  let wins = 0;
  let largestStake = 0;

  let currentDay = '';
  let dayPnl = 0;
  let dayStopped = false;
  let daysStopped = 0;

  const rung = (k: number) =>
    k < MAX_RUNGS
      ? { stake: cfg.base * cfg.factor ** k, target: cfg.target + cfg.step * k }
      : null;

  const rollDay = (ms: number): void => {
    const key = dayKey(ms + cfg.dayOffset * 3_600_000, 'utc');
    if (key === currentDay) return;
    if (dayStopped) daysStopped++;
    currentDay = key;
    dayPnl = 0;
    dayStopped = false;
  };
  const stopHit = (): boolean => cfg.stopLoss > 0 && -dayPnl >= cfg.stopLoss;

  const continuous = cfg.after === 0;

  for (let i = 0; i < games.length; i++) {
    const game = games[i]!;
    rollDay(game.endedAt);

    // Decide whether a ladder starts, and on which game.
    let start: number;
    if (continuous) {
      start = i;
    } else {
      if (game.bust < cfg.under) {
        run++;
        continue;
      }
      const qualifies = run >= cfg.after;
      run = 0;
      if (!qualifies) continue;
      start = i + 1;
    }
    if (start >= games.length) break;

    opportunities++;
    if (stopHit()) {
      dayStopped = true;
      continue;
    }
    const first = rung(0)!;
    if (balance < first.stake) {
      if (bankruptAt === null) bankruptAt = game.endedAt;
      continue;
    }

    laddersPlayed++;
    let won = false;
    let cut = false;
    let consumed = 0;
    for (let k = 0; start + k < games.length; k++) {
      const r = rung(k);
      if (!r || r.stake > balance) break;
      const next = games[start + k]!;
      // Judge the stop against the day the losses so far were booked on, so a
      // ladder that has already overrun the limit is cut even if its next bet
      // would fall on a fresh day. Then roll the day for the bet itself.
      if (stopHit()) {
        cut = true;
        dayStopped = true;
        break;
      }
      rollDay(next.endedAt);
      const overshoot = cfg.strict && cfg.stopLoss > 0 && dayPnl - r.stake < -cfg.stopLoss;
      if (overshoot) {
        cut = true;
        dayStopped = true;
        break;
      }
      consumed++;
      wagered += r.stake;
      bets++;
      if (r.stake > largestStake) largestStake = r.stake;
      if (next.bust >= r.target) {
        const gain = r.stake * (r.target - 1);
        balance += gain;
        dayPnl += gain;
        won = true;
        wins++;
        break;
      }
      balance -= r.stake;
      dayPnl -= r.stake;
    }
    if (!won) {
      if (cut) laddersCut++;
      else laddersFailed++;
    }

    // Skip the games the ladder used; in triggered mode, recount the run from
    // any trailing games under the threshold.
    if (continuous) {
      i = start + Math.max(consumed, 1) - 1;
    } else {
      run = 0;
      for (let k = consumed; k >= 1; k--) {
        if (games[i + k]!.bust < cfg.under) run++;
        else break;
      }
      i += consumed;
    }

    if (balance > peak) peak = balance;
    if (peak - balance > maxDrawdown) maxDrawdown = peak - balance;
  }
  if (dayStopped) daysStopped++;

  return {
    profit: balance - cfg.balance,
    finalBalance: balance,
    peak,
    maxDrawdown,
    wagered,
    laddersPlayed,
    laddersFailed,
    laddersCut,
    opportunities,
    daysStopped,
    bankruptAt,
    bets,
    wins,
    largestStake,
  };
}

export function describeConfig(cfg: StrategyConfig): string {
  const trigger = cfg.after === 0 ? 'every game' : `after ${cfg.after}+ under ${cfg.under}x`;
  const ladder = `${cfg.base.toLocaleString()}@${cfg.target}x x${cfg.factor}` + (cfg.step > 0 ? ` +${cfg.step}x` : '');
  const stop =
    cfg.stopLoss > 0 ? `stop ${cfg.stopLoss.toLocaleString()}${cfg.strict ? ' strict' : ''}` : 'no stop';
  return `${trigger}, ${ladder}, ${stop}`;
}
