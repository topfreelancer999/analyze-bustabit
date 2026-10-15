import { createHash, createHmac } from 'node:crypto';

/**
 * Bustabit's provably-fair math, ported from https://github.com/bustabit/verifier
 * (src/utils/math.ts and src/verifier.worker.ts).
 *
 * Every game's crash point is HMAC-SHA256 of the game hash under a public salt.
 * The hashes form a chain running backwards: hash(N-1) = sha256(hash(N)), so
 * knowing one recent hash lets us regenerate every earlier game offline.
 *
 * The collector uses this two ways: to check that a decoded frame really is the
 * game bustabit says it is, and to heal gaps after a disconnect.
 */

/** Salt from the 4th seeding event, Bitcoin block 917000. Games after VX_LAST_GAME. */
export const GAME_SALT = '00000000000000000001e08b7fd44f95e3e950ac65650a8031a6d5e1750e34be';

/** Salt from the 2nd seeding event, Bitcoin block 505750. Games 1..8,535,716. */
export const PREV_GAME_SALT = '0000000000000000004d6ec16dafe9d8370958664c1dc422f452892264c59526';

/** Terminating hash of the current chain, the low-id end. */
export const TERMINATING_HASH = '567a98370fb7545137ddb53687723cf0b8a1f5e93b1f76f4a1da29416930fa59';

/** Last game of the Vx (BLS) era. Games above this use GAME_SALT with plain HMAC. */
export const VX_LAST_GAME = 12_279_450;

/** Games at or below this id used the hex-string chain and PREV_GAME_SALT. */
export const PREV_CHAIN_LAST_GAME = 8_535_716;

/** Number of most significant bits of the digest used as the uniform draw. */
const N_BITS = 52;

/** The house edge, encoded in the numerator: 99 means 1%. */
const HOUSE_EDGE_NUMERATOR = 99;

/**
 * How the game hash is fed to HMAC. The verifier passes the decoded 32 bytes
 * ('raw'); 'hex' covers the alternative encoding in case a frame disagrees.
 * The collector picks one against live data and then pins it.
 */
export type VerifierMode = 'raw' | 'hex';

export const VERIFIER_MODES: VerifierMode[] = ['raw', 'hex'];

const HEX64 = /^[0-9a-f]{64}$/;

export function isGameHash(value: string): boolean {
  return HEX64.test(value);
}

export function hexToBytes(hex: string): Buffer {
  return Buffer.from(hex, 'hex');
}

export function bytesToHex(bytes: Buffer | Uint8Array): string {
  return Buffer.from(bytes).toString('hex');
}

/**
 * Turn an HMAC digest into a crash point.
 *
 * Takes the top 52 bits as a uniform X in [0, 1), then 99 / (1 - X) truncated to
 * two decimals. X < 0.01 yields 0.99 which clamps to 1.00, so exactly 1% of
 * games are instant busts. Kept separate from the HMAC so it can be tested
 * against hand-computed digests.
 */
export function bustFromDigestHex(digestHex: string): number {
  const seed = digestHex.slice(0, N_BITS / 4);
  const r = Number.parseInt(seed, 16);
  const uniform = r / 2 ** N_BITS;
  const x = HOUSE_EDGE_NUMERATOR / (1 - uniform);
  return Math.max(1, Math.floor(x) / 100);
}

/** Crash point for a game hash under an explicit salt. */
export function gameResultWithSalt(
  gameHash: string,
  salt: string,
  mode: VerifierMode = 'raw',
): number {
  const message = mode === 'raw' ? hexToBytes(gameHash) : Buffer.from(gameHash, 'utf8');
  const digest = createHmac('sha256', Buffer.from(salt, 'utf8')).update(message).digest('hex');
  return bustFromDigestHex(digest);
}

/** Crash point for a game hash on the current chain. */
export function gameResult(gameHash: string, mode: VerifierMode = 'raw'): number {
  return gameResultWithSalt(gameHash, GAME_SALT, mode);
}

/**
 * Crash point for a game whose id is known, choosing the salt for its era.
 * Vx-era games (10,000,001..12,279,450) need BLS signatures we do not implement,
 * so those return null rather than a wrong number.
 */
export function gameResultForId(gameHash: string, id: number, mode: VerifierMode = 'raw'): number | null {
  if (id > VX_LAST_GAME) return gameResultWithSalt(gameHash, GAME_SALT, mode);
  if (id <= PREV_CHAIN_LAST_GAME) return gameResultWithSalt(gameHash, PREV_GAME_SALT, 'hex');
  return null;
}

/**
 * Hash of the previous game: sha256 over the raw 32 bytes.
 * Only valid on the current chain. Games at or below PREV_CHAIN_LAST_GAME
 * hashed the hex string instead, which prevChainHashOfPrevious covers.
 */
export function previousHash(gameHash: string): string {
  return createHash('sha256').update(hexToBytes(gameHash)).digest('hex');
}

/** Previous-chain variant: sha256 over the ASCII hex string. */
export function previousHashLegacy(gameHash: string): string {
  return createHash('sha256').update(Buffer.from(gameHash, 'utf8')).digest('hex');
}

/**
 * Walk the chain backwards from a known hash.
 * Returns hashes for the `count` games before it, newest first.
 */
export function previousHashes(gameHash: string, count: number): string[] {
  const out: string[] = [];
  let current = gameHash;
  for (let i = 0; i < count; i++) {
    current = previousHash(current);
    out.push(current);
  }
  return out;
}

/**
 * Walk back from `fromHash` looking for `targetHash`, the last hash we stored.
 * Used to recover games missed during a disconnect. Returns the hashes strictly
 * between the two, oldest first, or null if the target is not found in range.
 */
export function chainGapTo(
  fromHash: string,
  targetHash: string,
  maxSteps: number,
): string[] | null {
  const between: string[] = [];
  let current = fromHash;
  for (let step = 0; step < maxSteps; step++) {
    current = previousHash(current);
    if (current === targetHash) return between.reverse();
    between.push(current);
  }
  return null;
}

/** True when `hash` is the game immediately after `previous` on the chain. */
export function chainsOnto(hash: string, previous: string): boolean {
  return previousHash(hash) === previous;
}

/** Compare two crash points at the two decimals bustabit actually reports. */
export function bustsEqual(a: number, b: number): boolean {
  return Math.round(a * 100) === Math.round(b * 100);
}

/**
 * Decide which HMAC input encoding matches live data.
 * Returns the mode that reproduces every sample, or null when none does, which
 * means the decode itself is wrong rather than the encoding.
 */
export function selectVerifierMode(
  samples: Array<{ hash: string; bust: number }>,
): VerifierMode | null {
  if (samples.length === 0) return null;
  for (const mode of VERIFIER_MODES) {
    if (samples.every((s) => bustsEqual(gameResult(s.hash, mode), s.bust))) return mode;
  }
  return null;
}
