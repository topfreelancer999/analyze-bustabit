import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { GameStore } from './db.ts';
import {
  COUNTDOWN_MS,
  endedAtFromCreated,
  flightMs,
  gameDurationMs,
  interpolateTimestamps,
  linkMissingIds,
  Recorder,
  GAME_OVERHEAD_MS,
  GROWTH_CONSTANT,
} from './recorder.ts';
import { gameResult, previousHash } from './verify.ts';

const T0 = Date.UTC(2026, 8, 10, 12, 0, 0);

/** A chain of hashes, oldest first, so tests can replay games in order. */
function chain(seed: string, length: number): string[] {
  const newest = createHash('sha256').update(seed).digest('hex');
  const hashes = [newest];
  for (let i = 1; i < length; i++) hashes.push(previousHash(hashes[i - 1]!));
  return hashes.reverse();
}

function frame(hash: string) {
  return { hash, bust: gameResult(hash), forcedAt: null };
}

function setup(options = {}) {
  const store = new GameStore(':memory:');
  const recorder = new Recorder(store, { verifierSamples: 2, ...options });
  return { store, recorder };
}

describe('gameDurationMs', () => {
  it('follows the doubling-every-10-seconds growth curve', () => {
    // 2x takes 10s of flight, plus the fixed countdown and settle.
    expect(gameDurationMs(2) - GAME_OVERHEAD_MS).toBeCloseTo(10_000, -1);
    expect(gameDurationMs(4) - GAME_OVERHEAD_MS).toBeCloseTo(20_000, -1);
    expect(gameDurationMs(1)).toBe(GAME_OVERHEAD_MS);
  });

  it('never returns less than the fixed overhead', () => {
    expect(gameDurationMs(0.5)).toBe(GAME_OVERHEAD_MS);
  });

  it('uses the growth constant from the site', () => {
    expect(GROWTH_CONSTANT).toBe(14_427);
  });
});

describe('endedAtFromCreated', () => {
  it('adds the countdown and the flight to the creation time', () => {
    // Checked against a real game: bustabit reported game 13595347 created at
    // 1789066741923 with a bust of 1.03, and the collector saw it crash at
    // 1789066747297, 52 ms from what this predicts.
    const predicted = endedAtFromCreated(1_789_066_741_923, 1.03);
    expect(Math.abs(predicted - 1_789_066_747_297)).toBeLessThan(100);
  });

  it('waits out the countdown even for an instant bust', () => {
    expect(endedAtFromCreated(T0, 1)).toBe(T0 + COUNTDOWN_MS);
  });

  it('grows with the multiplier', () => {
    expect(endedAtFromCreated(T0, 10)).toBeGreaterThan(endedAtFromCreated(T0, 2));
    expect(flightMs(2)).toBeCloseTo(10_000, -2);
  });
});

describe('interpolateTimestamps', () => {
  it('lands the final game exactly on the end time', () => {
    const times = interpolateTimestamps(T0, T0 + 100_000, [2, 2, 2]);
    expect(times).toHaveLength(3);
    expect(times.at(-1)).toBe(T0 + 100_000);
  });

  it('spaces equal games evenly', () => {
    const times = interpolateTimestamps(T0, T0 + 90_000, [2, 2, 2]);
    expect(times).toEqual([T0 + 30_000, T0 + 60_000, T0 + 90_000]);
  });

  it('gives a longer game a longer slice of the interval', () => {
    const [first, second] = interpolateTimestamps(T0, T0 + 100_000, [1, 100]);
    expect(first! - T0).toBeLessThan(T0 + 100_000 - first!);
    expect(second).toBe(T0 + 100_000);
  });

  it('stays inside the interval and keeps order', () => {
    const times = interpolateTimestamps(T0, T0 + 60_000, [1, 5, 2, 40, 1.2]);
    for (let i = 0; i < times.length; i++) {
      expect(times[i]!).toBeGreaterThan(T0);
      expect(times[i]!).toBeLessThanOrEqual(T0 + 60_000);
      if (i > 0) expect(times[i]!).toBeGreaterThanOrEqual(times[i - 1]!);
    }
  });

  it('returns nothing for no games', () => {
    expect(interpolateTimestamps(T0, T0 + 1000, [])).toEqual([]);
  });
});

describe('recording live games', () => {
  it('stores a game whose bust matches its hash', () => {
    const { store, recorder } = setup();
    const [hash] = chain('live', 1);
    const result = recorder.recordGameEnded(frame(hash!), T0);
    expect(result.outcome).toBe('stored');
    expect(store.stats().gamesStored).toBe(1);
    expect(store.latest()!.tsSource).toBe('live');
    expect(store.latest()!.endedAt).toBe(T0);
    store.close();
  });

  it('rejects a frame whose bust does not match its hash', () => {
    const { store, recorder } = setup();
    const [hash] = chain('bad', 1);
    const result = recorder.recordGameEnded({ hash: hash!, bust: 123.45, forcedAt: null }, T0);
    expect(result.outcome).toBe('decode-mismatch');
    expect(recorder.counters.decodeErrors).toBe(1);
    expect(store.stats().gamesStored).toBe(0);
    store.close();
  });

  it('rejects a malformed hash without touching the store', () => {
    const { store, recorder } = setup();
    const result = recorder.recordGameEnded({ hash: 'not-a-hash', bust: 2, forcedAt: null }, T0);
    expect(result.outcome).toBe('invalid');
    expect(recorder.counters.decodeErrors).toBe(1);
    expect(store.stats().gamesStored).toBe(0);
    store.close();
  });

  it('ignores a game already stored', () => {
    const { store, recorder } = setup();
    const [hash] = chain('dup', 1);
    recorder.recordGameEnded(frame(hash!), T0);
    const again = recorder.recordGameEnded(frame(hash!), T0 + 20_000);
    expect(again.outcome).toBe('duplicate');
    expect(store.stats().gamesStored).toBe(1);
    store.close();
  });

  it('records consecutive games without reporting a chain break', () => {
    const { store, recorder } = setup();
    const hashes = chain('seq', 4);
    hashes.forEach((hash, i) => {
      const result = recorder.recordGameEnded(frame(hash), T0 + i * 20_000);
      expect(result.chainBreak).toBe(false);
      expect(result.outcome).toBe('stored');
    });
    expect(store.stats().gamesStored).toBe(4);
    expect(recorder.counters.chainBreaks).toBe(0);
    store.close();
  });
});

describe('verifier mode', () => {
  it('pins the encoding after enough agreeing frames and remembers it', () => {
    const { store, recorder } = setup({ verifierSamples: 2 });
    const hashes = chain('pin', 2);
    expect(recorder.verifierMode).toBeNull();
    recorder.recordGameEnded(frame(hashes[0]!), T0);
    expect(recorder.verifierMode).toBeNull();
    recorder.recordGameEnded(frame(hashes[1]!), T0 + 20_000);
    expect(recorder.verifierMode).toBe('raw');
    expect(store.getMeta('verifier_mode')).toBe('raw');

    // A fresh recorder on the same store starts already pinned.
    expect(new Recorder(store).verifierMode).toBe('raw');
    store.close();
  });

  it('rejects frames that disagree with the pinned encoding', () => {
    const { store, recorder } = setup({ verifierSamples: 1 });
    const hashes = chain('pinned', 2);
    recorder.recordGameEnded(frame(hashes[0]!), T0);
    expect(recorder.verifierMode).toBe('raw');
    const result = recorder.recordGameEnded(
      { hash: hashes[1]!, bust: gameResult(hashes[1]!, 'hex'), forcedAt: null },
      T0 + 20_000,
    );
    expect(result.outcome).toBe('decode-mismatch');
    store.close();
  });
});

describe('healing gaps', () => {
  it('regenerates games missed during a disconnect', () => {
    const { store, recorder } = setup();
    const hashes = chain('gap', 6);
    recorder.recordGameEnded(frame(hashes[0]!), T0);
    // Games 1..4 are missed; only game 5 arrives.
    const result = recorder.recordGameEnded(frame(hashes[5]!), T0 + 100_000);

    expect(result.chainBreak).toBe(true);
    expect(result.healed).toBe(4);
    expect(recorder.counters.gamesHealed).toBe(4);
    expect(store.stats().gamesStored).toBe(6);

    const games = store.range(T0 - 1, T0 + 200_000, 100);
    expect(games.map((g) => g.hash)).toEqual(hashes);
    store.close();
  });

  it('marks healed games as interpolated and the live one as live', () => {
    const { store, recorder } = setup();
    const hashes = chain('marks', 4);
    recorder.recordGameEnded(frame(hashes[0]!), T0);
    recorder.recordGameEnded(frame(hashes[3]!), T0 + 60_000);

    const games = store.range(T0 - 1, T0 + 100_000, 100);
    expect(games.map((g) => g.tsSource)).toEqual(['live', 'interp', 'interp', 'live']);
    store.close();
  });

  it('gives healed games the busts the chain says they had', () => {
    const { store, recorder } = setup();
    const hashes = chain('busts', 4);
    recorder.recordGameEnded(frame(hashes[0]!), T0);
    recorder.recordGameEnded(frame(hashes[3]!), T0 + 60_000);

    const games = store.range(T0 - 1, T0 + 100_000, 100);
    expect(games.map((g) => g.bust)).toEqual(hashes.map((h) => gameResult(h)));
    store.close();
  });

  it('orders healed timestamps between the two known games', () => {
    const { store, recorder } = setup();
    const hashes = chain('times', 5);
    recorder.recordGameEnded(frame(hashes[0]!), T0);
    recorder.recordGameEnded(frame(hashes[4]!), T0 + 80_000);

    const games = store.range(T0 - 1, T0 + 200_000, 100);
    expect(games).toHaveLength(5);
    for (let i = 1; i < games.length; i++) {
      expect(games[i]!.endedAt).toBeGreaterThanOrEqual(games[i - 1]!.endedAt);
    }
    expect(games[0]!.endedAt).toBe(T0);
    expect(games[4]!.endedAt).toBe(T0 + 80_000);
    store.close();
  });

  it('gives up on a gap wider than the walk limit but still stores the game', () => {
    const { store, recorder } = setup({ maxHealSteps: 2 });
    const hashes = chain('wide', 10);
    recorder.recordGameEnded(frame(hashes[0]!), T0);
    const result = recorder.recordGameEnded(frame(hashes[9]!), T0 + 200_000);

    expect(result.chainBreak).toBe(true);
    expect(result.healed).toBe(0);
    expect(store.stats().gamesStored).toBe(2);
    store.close();
  });
});

describe('game ids', () => {
  it('uses the id announced by gameStarting', () => {
    const { store, recorder } = setup();
    const [hash] = chain('id', 1);
    recorder.noteGameStarting(13_600_001);
    recorder.recordGameEnded(frame(hash!), T0);
    expect(store.latest()!.id).toBe(13_600_001);
    store.close();
  });

  it('continues numbering from the previous game when none is announced', () => {
    const { store, recorder } = setup();
    const hashes = chain('nums', 3);
    recorder.noteGameStarting(500);
    recorder.recordGameEnded(frame(hashes[0]!), T0);
    recorder.recordGameEnded(frame(hashes[1]!), T0 + 20_000);
    recorder.recordGameEnded(frame(hashes[2]!), T0 + 40_000);
    expect(store.range(T0 - 1, T0 + 100_000, 10).map((g) => g.id)).toEqual([500, 501, 502]);
    store.close();
  });

  it('numbers a healed gap backwards from the announced id', () => {
    const { store, recorder } = setup();
    const hashes = chain('healids', 5);
    recorder.noteGameStarting(1_000);
    recorder.recordGameEnded(frame(hashes[0]!), T0);
    recorder.noteGameStarting(1_004);
    recorder.recordGameEnded(frame(hashes[4]!), T0 + 80_000);
    expect(store.range(T0 - 1, T0 + 100_000, 10).map((g) => g.id)).toEqual([
      1_000, 1_001, 1_002, 1_003, 1_004,
    ]);
    store.close();
  });

  it('leaves ids null when no anchor is known', () => {
    const { store, recorder } = setup();
    const hashes = chain('noid', 2);
    recorder.recordGameEnded(frame(hashes[0]!), T0);
    recorder.recordGameEnded(frame(hashes[1]!), T0 + 20_000);
    expect(store.range(T0 - 1, T0 + 100_000, 10).map((g) => g.id)).toEqual([null, null]);
    store.close();
  });

  it('does not reuse an announced id on a later game', () => {
    const { store, recorder } = setup();
    const hashes = chain('once', 2);
    recorder.noteGameStarting(700);
    recorder.recordGameEnded(frame(hashes[0]!), T0);
    recorder.recordGameEnded(frame(hashes[1]!), T0 + 20_000);
    const ids = store.range(T0 - 1, T0 + 100_000, 10).map((g) => g.id);
    expect(ids).toEqual([700, 701]);
    store.close();
  });
});

describe('counters', () => {
  it('tracks stored, healed, broken and rejected frames', () => {
    const { store, recorder } = setup();
    const hashes = chain('counters', 5);
    recorder.recordGameEnded(frame(hashes[0]!), T0);
    recorder.recordGameEnded(frame(hashes[4]!), T0 + 80_000); // heals 3
    recorder.recordGameEnded({ hash: 'zz', bust: 2, forcedAt: null }, T0 + 90_000);

    expect(recorder.counters.gamesStored).toBe(5);
    expect(recorder.counters.gamesHealed).toBe(3);
    expect(recorder.counters.chainBreaks).toBe(1);
    expect(recorder.counters.decodeErrors).toBe(1);
    store.close();
  });
});

describe('linkMissingIds', () => {
  /** Store a game directly, bypassing the recorder's own numbering. */
  function put(store: GameStore, hash: string, id: number | null, endedAt: number) {
    store.insert({ hash, id, bust: 2, forcedAt: null, endedAt, tsSource: 'live' });
  }

  it('numbers a game from the one before it', () => {
    const store = new GameStore(':memory:');
    const hashes = chain('orphan-pred', 2);
    put(store, hashes[1]!, null, T0 + 20_000);
    // Nothing to go on yet: neither neighbour is stored.
    expect(linkMissingIds(store)).toBe(0);

    put(store, hashes[0]!, 898, T0);
    expect(linkMissingIds(store)).toBe(1);
    expect(store.byHash(hashes[1]!)!.id).toBe(899);
    store.close();
  });

  it('numbers a game from the one after it', () => {
    const store = new GameStore(':memory:');
    const hashes = chain('orphan-succ', 2);
    put(store, hashes[0]!, null, T0);
    put(store, hashes[1]!, 1_500, T0 + 20_000);

    expect(linkMissingIds(store)).toBe(1);
    expect(store.byHash(hashes[0]!)!.id).toBe(1_499);
    store.close();
  });

  it('is the case the collector hits when it starts mid-round', () => {
    // The first game arrives before any round number is announced, so it is
    // stored by hash alone; the next game supplies the number.
    const { store, recorder } = setup();
    const hashes = chain('midround', 2);
    recorder.recordGameEnded(frame(hashes[0]!), T0);
    recorder.noteGameStarting(13_595_314);
    recorder.recordGameEnded(frame(hashes[1]!), T0 + 20_000);
    expect(store.withoutIds()).toHaveLength(1);

    expect(linkMissingIds(store)).toBe(1);
    expect(store.byHash(hashes[0]!)!.id).toBe(13_595_313);
    expect(store.withoutIds()).toHaveLength(0);
    store.close();
  });

  it('leaves a game alone when no neighbour is numbered', () => {
    const { store, recorder } = setup();
    const hashes = chain('orphan-alone', 2);
    recorder.recordGameEnded(frame(hashes[0]!), T0);
    recorder.recordGameEnded(frame(hashes[1]!), T0 + 20_000);
    expect(linkMissingIds(store)).toBe(0);
    expect(store.withoutIds()).toHaveLength(2);
    store.close();
  });

  it('does nothing when every game is already numbered', () => {
    const { store, recorder } = setup();
    recorder.noteGameStarting(50);
    recorder.recordGameEnded(frame(chain('all-numbered', 1)[0]!), T0);
    expect(store.withoutIds()).toHaveLength(0);
    expect(linkMissingIds(store)).toBe(0);
    store.close();
  });
});
