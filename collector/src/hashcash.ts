import { createHash } from 'node:crypto';

/**
 * Hashcash proof of work for the bustabit handshake.
 *
 * On connect the server sends a challenge string. The client must find a
 * counter whose sha256(challenge + counter) starts with a number of hex zeros
 * derived from the challenge's own first character. This is the same scheme the
 * site's bundled `hashcash` module implements.
 */

/** Difficulty in leading hex zeros, read from the challenge's first character. */
export function difficultyOf(challenge: string): number {
  const head = Number.parseInt(challenge[0] ?? '', 16);
  if (!Number.isFinite(head)) {
    throw new Error(`hashcash: challenge does not start with a hex digit: ${challenge.slice(0, 8)}`);
  }
  return head * 2;
}

export interface Solution {
  counter: number;
  digest: string;
  difficulty: number;
  iterations: number;
  ms: number;
}

/**
 * Find the smallest counter satisfying the challenge.
 * Throws rather than spinning forever if the difficulty is unexpectedly high.
 */
export function solve(challenge: string, maxIterations = 50_000_000): Solution {
  const difficulty = difficultyOf(challenge);
  const prefix = '0'.repeat(difficulty);
  const started = Date.now();
  for (let counter = 0; counter < maxIterations; counter++) {
    const digest = createHash('sha256').update(challenge + counter).digest('hex');
    if (digest.startsWith(prefix)) {
      return {
        counter,
        digest,
        difficulty,
        iterations: counter + 1,
        ms: Date.now() - started,
      };
    }
  }
  throw new Error(
    `hashcash: no solution for difficulty ${difficulty} within ${maxIterations} iterations`,
  );
}

/** Check a counter against a challenge. */
export function verify(challenge: string, counter: number): boolean {
  const digest = createHash('sha256').update(challenge + counter).digest('hex');
  return digest.startsWith('0'.repeat(difficultyOf(challenge)));
}
