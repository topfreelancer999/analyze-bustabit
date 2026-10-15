import { describe, expect, it } from 'vitest';
import { describeConfig, replayStrategy, type GameLite, type StrategyConfig } from './strategy.ts';

const T0 = Date.UTC(2026, 8, 10, 12, 0, 0);

/** Games 20 seconds apart, all on the same UTC day unless told otherwise. */
function games(busts: number[], startMs = T0): GameLite[] {
  return busts.map((bust, i) => ({ id: 1000 + i, bust, endedAt: startMs + i * 20_000 }));
}

const base: StrategyConfig = {
  balance: 1_000,
  after: 0,
  under: 2,
  base: 1,
  factor: 2,
  target: 2,
  step: 0,
  stopLoss: 0,
  strict: false,
  dayOffset: 0,
};

describe('continuous doubling', () => {
  it('nets one base bet per completed ladder', () => {
    // win; lose then win; win
    const r = replayStrategy(games([3, 1.5, 3, 2]), base);
    expect(r.profit).toBe(3);
    expect(r.laddersPlayed).toBe(3);
    expect(r.bets).toBe(4);
    expect(r.wins).toBe(3);
    expect(r.largestStake).toBe(2);
  });

  it('pays the ladder target, not the base target, when the target rises', () => {
    // lose at 2x, then win at 2.5x with stake 2: +3, minus the 1 lost = +2
    const r = replayStrategy(games([1.5, 2.5]), { ...base, step: 0.5 });
    expect(r.profit).toBe(2);
    expect(r.wins).toBe(1);
  });

  it('treats a bust exactly at the target as a win', () => {
    expect(replayStrategy(games([2]), base).profit).toBe(1);
  });

  it('fails the ladder and keeps the losses when the next stake cannot be placed', () => {
    // balance 7 funds 1+2+4; the fourth stake of 8 cannot be placed
    const r = replayStrategy(games([1.1, 1.1, 1.1, 1.1, 5]), { ...base, balance: 7 });
    expect(r.laddersFailed).toBe(1);
    expect(r.finalBalance).toBe(0);
    expect(r.bankruptAt).not.toBeNull();
  });

  it('counts bets at the fair rate on fair input', () => {
    const r = replayStrategy(games([3, 1.5, 3, 1.5, 3, 1.5, 3, 1.5]), base);
    expect(r.wins / r.bets).toBeCloseTo(0.5, 10);
  });
});

describe('streak trigger', () => {
  const cfg = { ...base, after: 2 };

  it('waits for a run to end, then bets on the games after it', () => {
    // run of 2 under 2x ends at index 2; the ladder starts at index 3 and wins
    const r = replayStrategy(games([1.5, 1.5, 3, 5, 1.2]), cfg);
    expect(r.opportunities).toBe(1);
    expect(r.laddersPlayed).toBe(1);
    expect(r.profit).toBe(1);
  });

  it('does not fire on a run that is too short', () => {
    const r = replayStrategy(games([1.5, 3, 5, 5]), cfg);
    expect(r.opportunities).toBe(0);
    expect(r.bets).toBe(0);
  });

  it('fires once per run however long the run is', () => {
    const r = replayStrategy(games([1.5, 1.5, 1.5, 1.5, 1.5, 3, 5]), cfg);
    expect(r.opportunities).toBe(1);
  });

  it('keeps watching the games a ladder used, so its losses can start the next run', () => {
    // run ends at 3; ladder loses on 1.5 and 1.6 (both under 2x) then wins on 4.
    // The win is at or above 2x, so the run restarts at 0 afterwards.
    const r = replayStrategy(games([1.5, 1.5, 3, 1.5, 1.6, 4, 1.5, 1.5, 3, 5]), cfg);
    expect(r.opportunities).toBe(2);
    expect(r.laddersPlayed).toBe(2);
  });
});

describe('daily stop-loss', () => {
  it('stops betting for the day once the net loss reaches the limit', () => {
    // continuous, base 10: lose 10, lose 20 -> day at -30 >= 15, no more bets that day
    const r = replayStrategy(games([1.1, 1.1, 5, 5, 5]), { ...base, base: 10, stopLoss: 15 });
    expect(r.bets).toBe(2);
    expect(r.profit).toBe(-30);
    expect(r.laddersCut).toBe(1);
    expect(r.daysStopped).toBe(1);
  });

  it('in strict mode refuses a bet that could take the day past the limit', () => {
    // lose 10 (-10); the next stake of 20 would reach -30, so it is refused
    const r = replayStrategy(games([1.1, 1.1, 5, 5]), {
      ...base,
      base: 10,
      stopLoss: 15,
      strict: true,
    });
    expect(r.bets).toBe(1);
    expect(r.profit).toBe(-10);
  });

  it('starts betting again on the next day', () => {
    const day1 = games([1.1, 1.1], T0);
    const day2 = games([5, 5], T0 + 86_400_000);
    const r = replayStrategy([...day1, ...day2], { ...base, base: 10, stopLoss: 15 });
    expect(r.bets).toBe(4);
    expect(r.profit).toBe(-30 + 20);
    expect(r.daysStopped).toBe(1);
  });

  it('moves the day boundary with dayOffset', () => {
    // Two games either side of UTC midnight. With the boundary shifted to 02:00,
    // both fall on the same day and the stop carries over.
    const beforeMidnight = Date.UTC(2026, 8, 10, 23, 59, 0);
    const list = [
      { id: 1, bust: 1.1, endedAt: beforeMidnight },
      { id: 2, bust: 1.1, endedAt: beforeMidnight + 20_000 },
      { id: 3, bust: 5, endedAt: beforeMidnight + 2 * 60_000 },
    ];
    const utc = replayStrategy(list, { ...base, base: 10, stopLoss: 15 });
    const shifted = replayStrategy(list, { ...base, base: 10, stopLoss: 15, dayOffset: 2 });
    expect(utc.bets).toBe(3); // the day rolled at 00:00 UTC, so game 3 was played
    expect(shifted.bets).toBe(2); // still the same day, still stopped
  });

  it('with no stop-loss never cuts a ladder', () => {
    const r = replayStrategy(games([1.1, 1.1, 1.1, 5]), { ...base, base: 10 });
    expect(r.laddersCut).toBe(0);
    expect(r.daysStopped).toBe(0);
  });
});

describe('bankruptcy', () => {
  it('records the first chance it could not fund and plays nothing', () => {
    const r = replayStrategy(games([5, 5]), { ...base, balance: 0.5 });
    expect(r.laddersPlayed).toBe(0);
    expect(r.bankruptAt).toBe(T0);
    expect(r.opportunities).toBe(2);
  });
});

describe('describeConfig', () => {
  it('names the trigger, ladder and stop', () => {
    expect(describeConfig(base)).toBe('every game, 1@2x x2, no stop');
    expect(
      describeConfig({ ...base, after: 10, base: 10_000, step: 0.5, stopLoss: 80_000, strict: true }),
    ).toBe('after 10+ under 2x, 10,000@2x x2 +0.5x, stop 80,000 strict');
  });
});
