import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { EXPECTED_INSTANT_BUST_SHARE } from '../../shared/expected.ts';
import {
  bustFromDigestHex,
  bustsEqual,
  chainGapTo,
  chainsOnto,
  GAME_SALT,
  gameResult,
  gameResultForId,
  isGameHash,
  previousHash,
  previousHashes,
  selectVerifierMode,
  VX_LAST_GAME,
} from './verify.ts';

/** Deterministic pseudo-hashes so the statistical tests are reproducible. */
function fakeHash(i: number): string {
  return createHash('sha256').update(`bustabit-test-${i}`).digest('hex');
}

describe('bustFromDigestHex', () => {
  it('turns the top 52 bits into a crash point', () => {
    // X = 0 -> 99 / 1 = 99 -> floor 99 -> 0.99 -> clamped to 1.00
    expect(bustFromDigestHex('0000000000000ffffffffffffffffffff')).toBe(1);
    // X = 1/2 -> 99 / 0.5 = 198 -> 1.98x, the fair median
    expect(bustFromDigestHex('8000000000000ffffffffffffffffffff')).toBe(1.98);
    // X = 1/4 -> 99 / 0.75 = 132 -> 1.32x
    expect(bustFromDigestHex('4000000000000ffffffffffffffffffff')).toBe(1.32);
    // X = 3/4 -> 99 / 0.25 = 396 -> 3.96x
    expect(bustFromDigestHex('c000000000000ffffffffffffffffffff')).toBe(3.96);
  });

  it('shows 1.00x for every draw below X = 2/101', () => {
    // floor(99/(1-X)) <= 100 means the game displays 1.00x, which covers both
    // the 1% clamped below 1 and the draws landing exactly on 100.
    const digest = (x: number) =>
      Math.floor(x * 2 ** 52).toString(16).padStart(13, '0') + '0'.repeat(51);
    expect(bustFromDigestHex(digest(0.005))).toBe(1);
    expect(bustFromDigestHex(digest(0.0198))).toBe(1);
    expect(bustFromDigestHex(digest(0.021))).toBe(1.01);
    expect(bustFromDigestHex(digest(0.03))).toBe(1.02);
  });

  it('ignores everything past the top 52 bits', () => {
    const a = bustFromDigestHex('8000000000000' + '0'.repeat(51));
    const b = bustFromDigestHex('8000000000000' + 'f'.repeat(51));
    expect(a).toBe(b);
  });

  it('never returns less than 1 and always has two decimals', () => {
    for (let i = 0; i < 500; i++) {
      const bust = bustFromDigestHex(fakeHash(i));
      expect(bust).toBeGreaterThanOrEqual(1);
      expect(Math.round(bust * 100)).toBeCloseTo(bust * 100, 6);
    }
  });
});

describe('gameResult', () => {
  it('is deterministic for a hash', () => {
    const hash = fakeHash(1);
    expect(gameResult(hash)).toBe(gameResult(hash));
  });

  it('depends on the salt and the encoding mode', () => {
    const hash = fakeHash(2);
    expect(gameResult(hash, 'raw')).not.toBe(gameResult(hash, 'hex'));
  });

  it('reproduces the 1% house edge over many draws', () => {
    const n = 20_000;
    let atLeast2 = 0;
    let atLeast10 = 0;
    let instant = 0;
    for (let i = 0; i < n; i++) {
      const bust = gameResult(fakeHash(i));
      if (bust >= 2) atLeast2++;
      if (bust >= 10) atLeast10++;
      if (bust === 1) instant++;
    }
    // Fair game: P(>= t) = 0.99 / t. Tolerances are ~4 standard errors.
    expect(atLeast2 / n).toBeGreaterThan(0.495 - 0.015);
    expect(atLeast2 / n).toBeLessThan(0.495 + 0.015);
    expect(atLeast10 / n).toBeGreaterThan(0.099 - 0.009);
    expect(atLeast10 / n).toBeLessThan(0.099 + 0.009);
    // 1.00x covers everything below 1.01x: 1 - 0.99/1.01 = 1.98%.
    expect(instant / n).toBeGreaterThan(EXPECTED_INSTANT_BUST_SHARE - 0.006);
    expect(instant / n).toBeLessThan(EXPECTED_INSTANT_BUST_SHARE + 0.006);
  });

  it('picks a salt per era and refuses Vx-era games', () => {
    const hash = fakeHash(3);
    expect(gameResultForId(hash, VX_LAST_GAME + 1)).toBe(gameResult(hash, 'raw'));
    expect(gameResultForId(hash, VX_LAST_GAME)).toBeNull();
    expect(gameResultForId(hash, 10_000_001)).toBeNull();
    expect(gameResultForId(hash, 1_000_000)).not.toBeNull();
  });

  it('uses the documented salt for the current chain', () => {
    expect(GAME_SALT).toHaveLength(64);
    expect(isGameHash(GAME_SALT)).toBe(true);
  });
});

describe('chain walking', () => {
  it('derives the previous hash by hashing the raw bytes', () => {
    const hash = fakeHash(10);
    const expected = createHash('sha256').update(Buffer.from(hash, 'hex')).digest('hex');
    expect(previousHash(hash)).toBe(expected);
    expect(isGameHash(previousHash(hash))).toBe(true);
  });

  it('walks backwards deterministically', () => {
    const hash = fakeHash(11);
    const walk = previousHashes(hash, 5);
    expect(walk).toHaveLength(5);
    expect(walk[0]).toBe(previousHash(hash));
    expect(walk[4]).toBe(previousHash(walk[3]!));
    expect(new Set(walk).size).toBe(5);
  });

  it('confirms a hash chains onto its predecessor', () => {
    const current = fakeHash(12);
    expect(chainsOnto(current, previousHash(current))).toBe(true);
    expect(chainsOnto(current, fakeHash(13))).toBe(false);
  });
});

describe('chainGapTo', () => {
  it('recovers the games missed between two known hashes, oldest first', () => {
    // Build a chain newest -> oldest, then ask for what sits between the ends.
    const newest = fakeHash(20);
    const walk = previousHashes(newest, 4); // 4 games before newest
    const stored = walk[3]!;
    const gap = chainGapTo(newest, stored, 100);
    expect(gap).toEqual([walk[2], walk[1], walk[0]]);
  });

  it('returns an empty gap when no games were missed', () => {
    const newest = fakeHash(21);
    expect(chainGapTo(newest, previousHash(newest), 100)).toEqual([]);
  });

  it('gives up rather than walking forever when the target is unreachable', () => {
    expect(chainGapTo(fakeHash(22), fakeHash(23), 50)).toBeNull();
  });
});

describe('selectVerifierMode', () => {
  it('identifies the encoding that reproduces the samples', () => {
    const raw = [1, 2, 3].map((i) => ({ hash: fakeHash(i), bust: gameResult(fakeHash(i), 'raw') }));
    const hex = [4, 5, 6].map((i) => ({ hash: fakeHash(i), bust: gameResult(fakeHash(i), 'hex') }));
    expect(selectVerifierMode(raw)).toBe('raw');
    expect(selectVerifierMode(hex)).toBe('hex');
  });

  it('returns null when the data matches no encoding, meaning a bad decode', () => {
    expect(selectVerifierMode([{ hash: fakeHash(7), bust: 123.45 }])).toBeNull();
    expect(selectVerifierMode([])).toBeNull();
  });
});

describe('bustsEqual', () => {
  it('compares at the two decimals bustabit reports', () => {
    expect(bustsEqual(1.98, 1.98)).toBe(true);
    expect(bustsEqual(1.9800000001, 1.98)).toBe(true);
    expect(bustsEqual(1.98, 1.99)).toBe(false);
  });
});
