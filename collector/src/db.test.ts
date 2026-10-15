import { describe, expect, it } from 'vitest';
import { GameStore, type GameRow } from './db.ts';

function store(): GameStore {
  return new GameStore(':memory:');
}

function row(hash: string, endedAt: number, over: Partial<GameRow> = {}): GameRow {
  return {
    hash: hash.padEnd(64, '0'),
    id: null,
    bust: 2,
    forcedAt: null,
    endedAt,
    tsSource: 'live',
    ...over,
  };
}

const T0 = Date.UTC(2026, 8, 10, 12, 0, 0);

describe('inserting', () => {
  it('stores a game and reports it as new', () => {
    const db = store();
    expect(db.insert(row('a', T0))).toBe(true);
    expect(db.has('a'.padEnd(64, '0'))).toBe(true);
    expect(db.stats().gamesStored).toBe(1);
    db.close();
  });

  it('ignores a game already stored, so reconnects cannot duplicate', () => {
    const db = store();
    db.insert(row('a', T0));
    expect(db.insert(row('a', T0 + 5_000, { bust: 99 }))).toBe(false);
    expect(db.stats().gamesStored).toBe(1);
    // The original values survive the duplicate insert.
    expect(db.latest()!.bust).toBe(2);
    db.close();
  });

  it('inserts a batch in one transaction and counts only the new rows', () => {
    const db = store();
    db.insert(row('a', T0));
    const inserted = db.insertMany([row('a', T0), row('b', T0 + 20_000), row('c', T0 + 40_000)]);
    expect(inserted).toBe(2);
    expect(db.stats().gamesStored).toBe(3);
    db.close();
  });

  it('rounds fractional timestamps to whole milliseconds', () => {
    const db = store();
    db.insert(row('a', T0 + 0.7));
    expect(db.latest()!.endedAt).toBe(T0 + 1);
    db.close();
  });

  it('rejects a timestamp source outside the allowed set instead of dropping it', () => {
    // A blanket INSERT OR IGNORE would swallow this silently.
    const db = store();
    expect(() => db.insert(row('a', T0, { tsSource: 'guess' as never }))).toThrow(/CHECK/i);
    expect(db.stats().gamesStored).toBe(0);
    db.close();
  });

  it('keeps a game whose derived id collides, dropping just the id', () => {
    const db = store();
    db.insert(row('a', T0, { id: 500 }));
    expect(db.insert(row('b', T0 + 20_000, { id: 500 }))).toBe(true);
    expect(db.idConflicts).toBe(1);
    expect(db.stats().gamesStored).toBe(2);
    expect(db.latest()!.id).toBeNull();
    db.close();
  });
});

describe('game ids', () => {
  it('fills in an id learned after the game was stored', () => {
    const db = store();
    db.insert(row('a', T0));
    db.setGameId('a'.padEnd(64, '0'), 13_600_001);
    expect(db.latest()!.id).toBe(13_600_001);
    db.close();
  });

  it('does not overwrite an id already known', () => {
    const db = store();
    db.insert(row('a', T0, { id: 100 }));
    db.setGameId('a'.padEnd(64, '0'), 999);
    expect(db.latest()!.id).toBe(100);
    db.close();
  });

  it('finds the newest and oldest anchors by id', () => {
    const db = store();
    db.insertMany([
      row('a', T0, { id: 10 }),
      row('b', T0 + 20_000, { id: 11 }),
      row('c', T0 + 40_000), // no id
    ]);
    expect(db.latestWithId()!.id).toBe(11);
    expect(db.earliestWithId()!.id).toBe(10);
    db.close();
  });

  it('reports no anchor on an empty database', () => {
    const db = store();
    expect(db.latest()).toBeNull();
    expect(db.latestWithId()).toBeNull();
    expect(db.earliestWithId()).toBeNull();
    db.close();
  });
});

describe('range queries', () => {
  const db = store();
  db.insertMany([
    row('a', T0, { bust: 1 }),
    row('b', T0 + 20_000, { bust: 5 }),
    row('c', T0 + 40_000, { bust: 12 }),
    row('d', T0 + 3_600_000, { bust: 2 }),
  ]);

  it('returns games in the window, oldest first', () => {
    const games = db.range(T0, T0 + 60_000, 100);
    expect(games.map((g) => g.bust)).toEqual([1, 5, 12]);
  });

  it('treats the window as half-open', () => {
    expect(db.range(T0, T0 + 20_000, 100).map((g) => g.bust)).toEqual([1]);
    expect(db.range(T0 + 20_000, T0 + 40_001, 100).map((g) => g.bust)).toEqual([5, 12]);
  });

  it('honours the row limit', () => {
    expect(db.range(T0, T0 + 3_700_000, 2)).toHaveLength(2);
  });

  it('counts without fetching', () => {
    expect(db.countInRange(T0, T0 + 60_000)).toBe(3);
    expect(db.countInRange(T0 + 100_000, T0 + 200_000)).toBe(0);
  });

  it('returns nothing for an empty window', () => {
    expect(db.range(T0 - 100_000, T0 - 1, 100)).toEqual([]);
  });
});

describe('latest', () => {
  it('returns the most recently ended game regardless of insert order', () => {
    const db = store();
    db.insert(row('b', T0 + 20_000, { bust: 5 }));
    db.insert(row('a', T0, { bust: 1 }));
    expect(db.latest()!.bust).toBe(5);
    db.close();
  });
});

describe('stats', () => {
  it('summarises what is stored', () => {
    const db = store();
    db.insertMany([row('a', T0, { id: 5 }), row('b', T0 + 20_000, { id: 6 })]);
    const stats = db.stats();
    expect(stats.gamesStored).toBe(2);
    expect(stats.oldest).toBe(T0);
    expect(stats.newest).toBe(T0 + 20_000);
    expect(stats.latestId).toBe(6);
    db.close();
  });

  it('reports empty rather than throwing with no rows', () => {
    const db = store();
    expect(db.stats()).toEqual({ gamesStored: 0, oldest: null, newest: null, latestId: null });
    db.close();
  });
});

describe('meta', () => {
  it('stores and overwrites keys', () => {
    const db = store();
    expect(db.getMeta('client_token')).toBeNull();
    db.setMeta('client_token', 'abc');
    expect(db.getMeta('client_token')).toBe('abc');
    db.setMeta('client_token', 'def');
    expect(db.getMeta('client_token')).toBe('def');
    db.close();
  });
});
