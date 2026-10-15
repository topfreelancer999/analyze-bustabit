import { FbTable, tryReadRoot } from './fb.ts';
import { isGameHash } from './verify.ts';

/**
 * Decoders for the three bustabit payloads the collector reads.
 *
 * Field indices come from the inferred schema and are confirmed by discovery
 * mode against real frames. Because they are inferred, nothing here is trusted
 * blindly: locate* falls back to searching the table by shape, and every
 * decoded game is checked against the provably-fair recomputation before it is
 * stored. A wrong index therefore shows up as a rejected frame, never as a
 * plausible but wrong number in the dashboard.
 */

/**
 * gameEnded, confirmed against live frames: slot 0 carries forcedAt and is
 * absent unless the game was force-ended, slot 1 the crash multiplier, slot 2
 * the game hash. Slots 3 and 4 hold bankroll figures the dashboard ignores.
 */
export const GAME_ENDED_FIELDS = { forcedAt: 0, bust: 1, hash: 2 } as const;

/** StrippedGameInfo: { id: int64, bust: float64, hash: string, forcedAt: float64 } */
export const STRIPPED_FIELDS = { id: 0, bust: 1, hash: 2, forcedAt: 3 } as const;

/** GameInfo: { strippedGameInfo: table, bets: [Bet], commission: float64, created: int64 } */
export const GAME_INFO_FIELDS = { stripped: 0, bets: 1, commission: 2, created: 3 } as const;

/** A finished game as read off the wire. */
export interface DecodedGameEnded {
  bust: number;
  hash: string;
  forcedAt: number | null;
}

/** A game read back through getGameInfo, which is the only source of timestamps. */
export interface DecodedGameInfo extends DecodedGameEnded {
  id: number | null;
  /** Millisecond epoch from bustabit's own clock. */
  created: number | null;
  commission: number | null;
  betCount: number;
}

/** Anything the gameStarting push tells us, mainly the upcoming game id. */
export interface DecodedGameStarting {
  id: number | null;
  /** Millisecond epoch the betting window closes, when present. */
  startTime: number | null;
}

const MIN_MS_EPOCH = 1_400_000_000_000; // 2014
const MAX_MS_EPOCH = 4_000_000_000_000; // 2096

function isPlausibleBust(value: number | undefined): value is number {
  return value !== undefined && Number.isFinite(value) && value >= 1 && value < 10_000_000;
}

function isPlausibleEpoch(value: number | undefined): value is number {
  return value !== undefined && value > MIN_MS_EPOCH && value < MAX_MS_EPOCH;
}

function isPlausibleGameId(value: number | undefined): value is number {
  return value !== undefined && Number.isInteger(value) && value > 1 && value < 1_000_000_000;
}

/** Read an int64 slot without letting an out-of-range value abort the decode. */
function safeI64(table: FbTable, index: number): number | undefined {
  try {
    return table.i64(index);
  } catch {
    return undefined;
  }
}

function safeStr(table: FbTable, index: number): string | undefined {
  try {
    return table.str(index);
  } catch {
    return undefined;
  }
}

/** Find the game hash: the expected slot, else the only 64-hex string present. */
function locateHash(table: FbTable, expected: number): string | undefined {
  const direct = safeStr(table, expected);
  if (direct !== undefined && isGameHash(direct)) return direct;
  for (let i = 0; i < table.fieldCount; i++) {
    const value = safeStr(table, i);
    if (value !== undefined && isGameHash(value)) return value;
  }
  return undefined;
}

/** Find the crash multiplier: the expected slot, else the first plausible double. */
function locateBust(table: FbTable, expected: number, skip: number[] = []): number | undefined {
  const direct = table.f64(expected);
  if (isPlausibleBust(direct)) return direct;
  for (let i = 0; i < table.fieldCount; i++) {
    if (i === expected || skip.includes(i)) continue;
    const value = table.f64(i);
    if (isPlausibleBust(value)) return value;
  }
  return undefined;
}

/** Find a millisecond epoch: the expected slot, else the first plausible int64. */
function locateEpoch(table: FbTable, expected: number): number | undefined {
  const direct = safeI64(table, expected);
  if (isPlausibleEpoch(direct)) return direct;
  for (let i = 0; i < table.fieldCount; i++) {
    if (i === expected) continue;
    const value = safeI64(table, i);
    if (isPlausibleEpoch(value)) return value;
  }
  return undefined;
}

/** Find a game id: the expected slot, else the first plausible non-epoch int64. */
function locateGameId(table: FbTable, expected: number): number | undefined {
  const direct = safeI64(table, expected);
  if (isPlausibleGameId(direct) && !isPlausibleEpoch(direct)) return direct;
  for (let i = 0; i < table.fieldCount; i++) {
    if (i === expected) continue;
    const value = safeI64(table, i);
    if (isPlausibleGameId(value) && !isPlausibleEpoch(value)) return value;
  }
  return undefined;
}

export function decodeGameEnded(payload: Buffer): DecodedGameEnded | null {
  const table = tryReadRoot(payload);
  if (!table) return null;

  const hash = locateHash(table, GAME_ENDED_FIELDS.hash);
  const bust = locateBust(table, GAME_ENDED_FIELDS.bust, [GAME_ENDED_FIELDS.forcedAt]);
  if (hash === undefined || bust === undefined) return null;

  // forcedAt is absent on a normal game, so read the slot directly rather than
  // searching, which would otherwise find the bust and report every game forced.
  const forcedAt = table.f64(GAME_ENDED_FIELDS.forcedAt);
  return {
    bust,
    hash,
    forcedAt: forcedAt !== undefined && Number.isFinite(forcedAt) ? forcedAt : null,
  };
}

export function decodeGameStarting(payload: Buffer): DecodedGameStarting | null {
  const table = tryReadRoot(payload);
  if (!table) return null;
  const id = locateGameId(table, 0);
  const startTime = locateEpoch(table, 1);
  if (id === undefined && startTime === undefined) return null;
  return { id: id ?? null, startTime: startTime ?? null };
}

export function decodeGameInfo(payload: Buffer): DecodedGameInfo | null {
  const table = tryReadRoot(payload);
  if (!table) return null;

  // The interesting fields live in the nested StrippedGameInfo, but tolerate a
  // flat layout in case the schema differs from what was inferred.
  const stripped = table.table(GAME_INFO_FIELDS.stripped) ?? table;
  const hash = locateHash(stripped, STRIPPED_FIELDS.hash) ?? locateHash(table, STRIPPED_FIELDS.hash);
  const bust = locateBust(stripped, STRIPPED_FIELDS.bust) ?? locateBust(table, STRIPPED_FIELDS.bust);
  if (hash === undefined || bust === undefined) return null;

  const id = locateGameId(stripped, STRIPPED_FIELDS.id) ?? locateGameId(table, STRIPPED_FIELDS.id);
  const created = locateEpoch(table, GAME_INFO_FIELDS.created);
  const forcedAt = stripped.f64(STRIPPED_FIELDS.forcedAt);
  const commission = table.f64(GAME_INFO_FIELDS.commission);

  return {
    id: id ?? null,
    bust,
    hash,
    created: created ?? null,
    forcedAt: forcedAt !== undefined && Number.isFinite(forcedAt) ? forcedAt : null,
    commission: commission !== undefined && Number.isFinite(commission) ? commission : null,
    betCount: table.vectorLength(GAME_INFO_FIELDS.bets),
  };
}

/**
 * Encode a getGameInfo request: a root table whose only field is an int64 id.
 * Written by hand because this is the one message the collector ever sends.
 */
export function encodeGameInfoRequest(id: number): Buffer {
  const buf = Buffer.alloc(24);
  // vtable: size 6 (header + one slot), table size 12, slot 0 at offset 4
  buf.writeUInt32LE(10, 0); // root uoffset -> table at 10
  buf.writeUInt16LE(6, 4); // vtable size
  buf.writeUInt16LE(12, 6); // table inline size
  buf.writeUInt16LE(4, 8); // slot 0 voffset
  buf.writeInt32LE(10 - 4, 10); // soffset back to the vtable
  buf.writeBigInt64LE(BigInt(id), 14);
  return buf.subarray(0, 22);
}
