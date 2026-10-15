import { describe, expect, it } from 'vitest';
import {
  decodeGameEnded,
  decodeGameStarting,
  encodeGameInfoRequest,
  GAME_ENDED_FIELDS,
} from './decode.ts';
import { readRoot } from './fb.ts';
import { bustsEqual, gameResult, isGameHash, previousHash } from './verify.ts';
import { frame, GAME_ENDED_FRAMES, GAME_STARTING_FRAMES } from '../fixtures/frames.ts';

/**
 * These run against frames captured from the live game, so they check the
 * decoders against the wire format rather than against our own assumptions.
 */

describe('decodeGameEnded on live frames', () => {
  it('decodes every captured frame', () => {
    for (const encoded of GAME_ENDED_FRAMES) {
      const decoded = decodeGameEnded(frame(encoded));
      expect(decoded).not.toBeNull();
      expect(isGameHash(decoded!.hash)).toBe(true);
      expect(decoded!.bust).toBeGreaterThanOrEqual(1);
    }
  });

  it('reproduces every reported bust from its hash', () => {
    // This is the decode self-check: if the fields were read from the wrong
    // slots, the provably-fair recomputation would not agree.
    for (const encoded of GAME_ENDED_FRAMES) {
      const decoded = decodeGameEnded(frame(encoded))!;
      expect(bustsEqual(gameResult(decoded.hash, 'raw'), decoded.bust)).toBe(true);
    }
  });

  it('produces hashes that chain, since the frames were captured in order', () => {
    const hashes = GAME_ENDED_FRAMES.map((f) => decodeGameEnded(frame(f))!.hash);
    for (let i = 1; i < hashes.length; i++) {
      expect(previousHash(hashes[i]!)).toBe(hashes[i - 1]);
    }
  });

  it('reports no forcedAt for games that ended normally', () => {
    // Slot 0 is absent on a normal game. Reading it by search would find the
    // bust instead and wrongly mark every game as force-ended.
    for (const encoded of GAME_ENDED_FRAMES) {
      const decoded = decodeGameEnded(frame(encoded))!;
      expect(decoded.forcedAt).toBeNull();
    }
  });

  it('reads the bust from slot 1 and the hash from slot 2', () => {
    const table = readRoot(frame(GAME_ENDED_FRAMES[0]!));
    const decoded = decodeGameEnded(frame(GAME_ENDED_FRAMES[0]!))!;
    expect(table.f64(GAME_ENDED_FIELDS.bust)).toBeCloseTo(decoded.bust, 10);
    expect(table.str(GAME_ENDED_FIELDS.hash)).toBe(decoded.hash);
    expect(table.has(GAME_ENDED_FIELDS.forcedAt)).toBe(false);
  });

  it('covers a spread of real crash points', () => {
    const busts = GAME_ENDED_FRAMES.map((f) => decodeGameEnded(frame(f))!.bust);
    expect(Math.min(...busts)).toBeLessThan(2);
    expect(Math.max(...busts)).toBeGreaterThan(2);
  });
});

describe('decodeGameStarting on live frames', () => {
  it('reads the upcoming game id from every captured frame', () => {
    for (const encoded of GAME_STARTING_FRAMES) {
      const decoded = decodeGameStarting(frame(encoded));
      expect(decoded).not.toBeNull();
      expect(decoded!.id).toBeGreaterThan(13_000_000);
      expect(Number.isInteger(decoded!.id)).toBe(true);
    }
  });

  it('numbers the captured games consecutively', () => {
    const ids = GAME_STARTING_FRAMES.map((f) => decodeGameStarting(frame(f))!.id!);
    for (let i = 1; i < ids.length; i++) {
      expect(ids[i]).toBe(ids[i - 1]! + 1);
    }
  });

  it('does not mistake the game id for a timestamp', () => {
    const decoded = decodeGameStarting(frame(GAME_STARTING_FRAMES[0]!))!;
    expect(decoded.startTime).toBeNull();
  });
});

describe('rejecting bad input', () => {
  it('returns null rather than throwing on junk', () => {
    expect(decodeGameEnded(Buffer.alloc(0))).toBeNull();
    expect(decodeGameEnded(Buffer.from('not flatbuffers at all'))).toBeNull();
    expect(decodeGameStarting(Buffer.alloc(3))).toBeNull();
  });

  it('returns null for a truncated frame', () => {
    const full = frame(GAME_ENDED_FRAMES[0]!);
    expect(decodeGameEnded(full.subarray(0, 20))).toBeNull();
  });

  it('returns null when the payload has no game hash', () => {
    const starting = frame(GAME_STARTING_FRAMES[0]!);
    expect(decodeGameEnded(starting)).toBeNull();
  });
});

describe('encodeGameInfoRequest', () => {
  it('builds a table whose only field is the game id', () => {
    const table = readRoot(encodeGameInfoRequest(13_595_301));
    expect(table.i64(0)).toBe(13_595_301);
    expect(table.fieldCount).toBe(1);
  });

  it('round-trips a range of ids', () => {
    for (const id of [1, 8_535_716, 12_279_451, 13_600_000]) {
      expect(readRoot(encodeGameInfoRequest(id)).i64(0)).toBe(id);
    }
  });
});
