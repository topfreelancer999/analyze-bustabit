import type { GameRow, GameStore } from './db.ts';
import type { DecodedGameEnded } from './decode.ts';
import {
  bustsEqual,
  chainGapTo,
  chainsOnto,
  gameResult,
  isGameHash,
  previousHash,
  VERIFIER_MODES,
  type VerifierMode,
} from './verify.ts';

/**
 * Turns decoded frames into stored games.
 *
 * Two invariants are enforced before anything is written. The bust must match
 * the provably-fair recomputation from the hash, which proves the FlatBuffers
 * decode was read from the right fields. And the hash must chain onto the last
 * game stored, which proves nothing was missed; when it does not, the missing
 * games are regenerated from the chain rather than left as a hole.
 */

/** Multiplier growth: bust = 2^(elapsed_ms / 10000), so elapsed = 14427 * ln(bust). */
export const GROWTH_CONSTANT = 14_427;

/** Betting window between a game being created and the multiplier starting to climb. */
export const COUNTDOWN_MS = 5_000;

/** Pause between one game busting and the next being created. */
export const SETTLE_MS = 3_000;

/**
 * The fixed part of a game cycle. Measured against collected games the residual
 * after removing flight time has a median of 8021 ms, so this constant is
 * accurate to about 20 ms per game.
 */
export const GAME_OVERHEAD_MS = COUNTDOWN_MS + SETTLE_MS;

/** How long the multiplier climbed before crashing at `bust`. */
export function flightMs(bust: number): number {
  return GROWTH_CONSTANT * Math.log(Math.max(1, bust));
}

/** How long a game that crashed at `bust` took, one crash to the next. */
export function gameDurationMs(bust: number): number {
  return flightMs(bust) + GAME_OVERHEAD_MS;
}

/**
 * When a game crashed, from the creation time bustabit reports for it.
 * Checked against live games: this predicts the observed crash within ~50 ms.
 */
export function endedAtFromCreated(created: number, bust: number): number {
  return created + COUNTDOWN_MS + flightMs(bust);
}

/**
 * Spread games evenly between two known times, weighted by how long each game
 * would have taken. The last game lands exactly on `endTime`.
 */
export function interpolateTimestamps(
  startTime: number,
  endTime: number,
  busts: number[],
): number[] {
  if (busts.length === 0) return [];
  const weights = busts.map(gameDurationMs);
  const total = weights.reduce((a, b) => a + b, 0);
  const span = endTime - startTime;
  const out: number[] = [];
  let cumulative = 0;
  for (const weight of weights) {
    cumulative += weight;
    out.push(Math.round(startTime + (cumulative / total) * span));
  }
  return out;
}

/**
 * Give a number to games stored without one.
 *
 * A game that arrives before the collector has been told the round number is
 * stored by hash alone. Once a neighbour is known, the chain settles the
 * question: the game before it hashes to its predecessor, and its successor
 * hashes to it. Run after collection or a backfill, when neighbours exist.
 */
export function linkMissingIds(store: GameStore): number {
  let fixed = 0;
  for (const orphan of store.withoutIds()) {
    const predecessor = store.byHash(previousHash(orphan.hash));
    if (predecessor?.id != null) {
      store.setGameId(orphan.hash, predecessor.id + 1);
      fixed++;
      continue;
    }
    // Otherwise look just ahead for the game that chains onto this one.
    const successor = store
      .after(orphan.endedAt, 4)
      .find((row) => row.id !== null && previousHash(row.hash) === orphan.hash);
    if (successor?.id != null) {
      store.setGameId(orphan.hash, successor.id - 1);
      fixed++;
    }
  }
  return fixed;
}

export type RecordOutcome =
  | 'stored'
  | 'duplicate'
  /** The bust did not match the hash, so the decode is not trustworthy. */
  | 'decode-mismatch'
  | 'invalid';

export interface RecordResult {
  outcome: RecordOutcome;
  /** Games recovered from the chain because they were missed. */
  healed: number;
  /** True when the hash did not chain onto the last stored game. */
  chainBreak: boolean;
  row?: GameRow;
}

export interface RecorderCounters {
  gamesStored: number;
  decodeErrors: number;
  chainBreaks: number;
  gamesHealed: number;
}

export interface RecorderOptions {
  maxHealSteps?: number;
  /** Frames that must agree before the HMAC encoding is pinned. */
  verifierSamples?: number;
  now?: () => number;
}

const VERIFIER_MODE_KEY = 'verifier_mode';

export class Recorder {
  private readonly store: GameStore;
  private readonly maxHealSteps: number;
  private readonly verifierSamples: number;
  private readonly now: () => number;
  private readonly samples: Array<{ hash: string; bust: number }> = [];
  private mode: VerifierMode | null;
  /** Game id learned from gameStarting, applied to the next gameEnded. */
  private pendingId: number | null = null;

  readonly counters: RecorderCounters = {
    gamesStored: 0,
    decodeErrors: 0,
    chainBreaks: 0,
    gamesHealed: 0,
  };

  constructor(store: GameStore, options: RecorderOptions = {}) {
    this.store = store;
    this.maxHealSteps = options.maxHealSteps ?? 10_000;
    this.verifierSamples = options.verifierSamples ?? 3;
    this.now = options.now ?? Date.now;
    const stored = store.getMeta(VERIFIER_MODE_KEY);
    this.mode = stored === 'raw' || stored === 'hex' ? stored : null;
  }

  /** The HMAC encoding in use, or null while it is still being determined. */
  get verifierMode(): VerifierMode | null {
    return this.mode;
  }

  /** Remember the id announced for the game about to start. */
  noteGameStarting(id: number | null): void {
    if (id !== null && Number.isInteger(id) && id > 0) this.pendingId = id;
  }

  /**
   * Check a frame against the provably-fair math.
   * Returns the encoding that reproduces it, or null when none does.
   */
  private checkVerifier(hash: string, bust: number): VerifierMode | null {
    if (this.mode) return bustsEqual(gameResult(hash, this.mode), bust) ? this.mode : null;
    for (const mode of VERIFIER_MODES) {
      if (bustsEqual(gameResult(hash, mode), bust)) return mode;
    }
    return null;
  }

  private maybePinMode(mode: VerifierMode, hash: string, bust: number): void {
    if (this.mode) return;
    this.samples.push({ hash, bust });
    if (this.samples.length < this.verifierSamples) return;
    // Pin only if every sample so far agrees on the same encoding.
    const agreed = this.samples.every((s) => bustsEqual(gameResult(s.hash, mode), s.bust));
    if (agreed) {
      this.mode = mode;
      this.store.setMeta(VERIFIER_MODE_KEY, mode);
    } else {
      this.samples.length = 0;
    }
  }

  /** Record a finished game, healing any gap before it. */
  recordGameEnded(decoded: DecodedGameEnded, endedAt = this.now()): RecordResult {
    const { hash, bust } = decoded;
    if (!isGameHash(hash) || !Number.isFinite(bust) || bust < 1) {
      this.counters.decodeErrors++;
      return { outcome: 'invalid', healed: 0, chainBreak: false };
    }

    const mode = this.checkVerifier(hash, bust);
    if (mode === null) {
      this.counters.decodeErrors++;
      return { outcome: 'decode-mismatch', healed: 0, chainBreak: false };
    }
    this.maybePinMode(mode, hash, bust);

    if (this.store.has(hash)) {
      this.pendingId = null;
      return { outcome: 'duplicate', healed: 0, chainBreak: false };
    }

    const id = this.pendingId;
    this.pendingId = null;

    const previous = this.store.latest();
    let healed = 0;
    let chainBreak = false;

    if (previous && !chainsOnto(hash, previous.hash)) {
      chainBreak = true;
      this.counters.chainBreaks++;
      healed = this.healGap(hash, previous, endedAt, id, mode);
    }

    const row: GameRow = {
      hash,
      id: id ?? this.deriveId(hash),
      bust,
      forcedAt: decoded.forcedAt,
      endedAt,
      tsSource: 'live',
    };
    const stored = this.store.insert(row);
    if (stored) this.counters.gamesStored++;
    return { outcome: stored ? 'stored' : 'duplicate', healed, chainBreak, row };
  }

  /**
   * Regenerate games missed between the last stored game and this one.
   * Their busts come from the chain, their timestamps from interpolation.
   */
  private healGap(
    hash: string,
    previous: GameRow,
    endedAt: number,
    newId: number | null,
    mode: VerifierMode,
  ): number {
    const missing = chainGapTo(hash, previous.hash, this.maxHealSteps);
    if (missing === null || missing.length === 0) return 0;

    const busts = missing.map((h) => gameResult(h, mode));
    // Include the new game so the interval is divided over everything in it.
    const times = interpolateTimestamps(previous.endedAt, endedAt, [...busts, 0]);

    // Number the gap forwards from whichever end has a known id.
    const firstId =
      newId !== null
        ? newId - missing.length
        : previous.id !== null
          ? previous.id + 1
          : null;

    const rows: GameRow[] = missing.map((h, i) => ({
      hash: h,
      id: firstId === null ? null : firstId + i,
      bust: busts[i]!,
      forcedAt: null,
      endedAt: times[i]!,
      tsSource: 'interp',
    }));

    const inserted = this.store.insertMany(rows);
    this.counters.gamesHealed += inserted;
    this.counters.gamesStored += inserted;
    return inserted;
  }

  /** Number a game from the last stored one when the server did not say. */
  private deriveId(hash: string): number | null {
    const previous = this.store.latest();
    if (!previous || previous.id === null) return null;
    return chainsOnto(hash, previous.hash) ? previous.id + 1 : null;
  }
}
