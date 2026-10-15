import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { difficultyOf, solve, verify } from './hashcash.ts';

describe('difficultyOf', () => {
  it('doubles the leading hex digit', () => {
    expect(difficultyOf('1abc')).toBe(2);
    expect(difficultyOf('2abc')).toBe(4);
    expect(difficultyOf('0abc')).toBe(0);
    expect(difficultyOf('a123')).toBe(20);
  });

  it('rejects a challenge that does not start with a hex digit', () => {
    expect(() => difficultyOf('zzz')).toThrow(/hex digit/);
    expect(() => difficultyOf('')).toThrow(/hex digit/);
  });
});

describe('solve', () => {
  it('finds a counter whose digest has the required zeros', () => {
    const challenge = '1f3a9c0d2e';
    const solution = solve(challenge);
    expect(solution.difficulty).toBe(2);
    expect(solution.digest.startsWith('00')).toBe(true);
    expect(createHash('sha256').update(challenge + solution.counter).digest('hex')).toBe(
      solution.digest,
    );
    expect(solution.iterations).toBe(solution.counter + 1);
  });

  it('returns the smallest counter that works', () => {
    const challenge = '1deadbeef';
    const { counter } = solve(challenge);
    for (let i = 0; i < counter; i++) {
      expect(verify(challenge, i)).toBe(false);
    }
    expect(verify(challenge, counter)).toBe(true);
  });

  it('solves a difficulty-4 challenge in reasonable time', () => {
    const solution = solve('2abcdef123');
    expect(solution.difficulty).toBe(4);
    expect(solution.digest.startsWith('0000')).toBe(true);
    expect(solution.ms).toBeLessThan(20_000);
  });

  it('is deterministic for the same challenge', () => {
    expect(solve('1aaa').counter).toBe(solve('1aaa').counter);
  });

  it('gives up instead of spinning forever', () => {
    expect(() => solve('faaa', 5_000)).toThrow(/no solution/);
  });

  it('accepts a zero-difficulty challenge immediately', () => {
    const solution = solve('0abc');
    expect(solution.counter).toBe(0);
    expect(solution.difficulty).toBe(0);
  });
});

describe('verify', () => {
  it('rejects a wrong counter', () => {
    const challenge = '1f3a9c0d2e';
    const { counter } = solve(challenge);
    expect(verify(challenge, counter)).toBe(true);
    expect(verify(challenge, counter + 1)).toBe(false);
  });
});
