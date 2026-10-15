import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Game, TsSource } from '../../shared/types.ts';

/**
 * SQLite storage for collected games.
 *
 * The game hash is the primary key: gameEnded frames carry no id, and the hash
 * is unique and verifiable, so it is the only identifier always available.
 * Inserts are idempotent, which lets a reconnect or a backfill re-cover ground
 * without creating duplicates.
 */

export interface GameRow {
  hash: string;
  id: number | null;
  bust: number;
  forcedAt: number | null;
  endedAt: number;
  tsSource: TsSource;
}

export interface Stats {
  gamesStored: number;
  oldest: number | null;
  newest: number | null;
  latestId: number | null;
}

export class GameStore {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      -- The collector and a backfill can be running at once, so wait for the
      -- other writer rather than failing the insert outright.
      PRAGMA busy_timeout = 10000;
      CREATE TABLE IF NOT EXISTS games (
        hash      TEXT PRIMARY KEY,
        id        INTEGER UNIQUE,
        bust      REAL NOT NULL,
        forced_at REAL,
        ended_at  INTEGER NOT NULL,
        ts_source TEXT NOT NULL CHECK (ts_source IN ('live', 'rpc', 'interp')),
        seen_at   INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS games_ended_at ON games (ended_at);
      CREATE TABLE IF NOT EXISTS meta (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
  }

  close(): void {
    this.db.close();
  }

  getMeta(key: string): string | null {
    const row = this.db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as
      | { value: string }
      | undefined;
    return row?.value ?? null;
  }

  setMeta(key: string, value: string): void {
    this.db
      .prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = ?')
      .run(key, value, value);
  }

  /**
   * Insert a game, ignoring one already stored. Returns true when it was new.
   *
   * The conflict clause names the hash deliberately. A blanket INSERT OR IGNORE
   * would also swallow CHECK and NOT NULL violations, hiding bad data instead of
   * surfacing it. A clash on the derived id means two hashes claim the same game
   * number, so the row is kept without an id and counted as an anomaly rather
   * than lost or allowed to corrupt the numbering.
   */
  insert(row: GameRow): boolean {
    try {
      return this.runInsert(row, row.id);
    } catch (error) {
      if (row.id !== null && isIdConflict(error)) {
        this.idConflicts++;
        return this.runInsert(row, null);
      }
      throw error;
    }
  }

  /** Games whose derived id collided with one already stored. */
  idConflicts = 0;

  private runInsert(row: GameRow, id: number | null): boolean {
    const result = this.db
      .prepare(
        `INSERT INTO games (hash, id, bust, forced_at, ended_at, ts_source, seen_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(hash) DO NOTHING`,
      )
      .run(row.hash, id, row.bust, row.forcedAt, Math.round(row.endedAt), row.tsSource, Date.now());
    return result.changes > 0;
  }

  /** Insert many games in one transaction. Returns how many were new. */
  insertMany(rows: GameRow[]): number {
    if (rows.length === 0) return 0;
    let inserted = 0;
    this.db.exec('BEGIN');
    try {
      for (const row of rows) if (this.insert(row)) inserted++;
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return inserted;
  }

  /**
   * Attach an id to a game already stored by hash.
   * Used when gameStarting or a backfill probe reveals the number afterwards.
   */
  setGameId(hash: string, id: number): void {
    this.db.prepare('UPDATE games SET id = ? WHERE hash = ? AND id IS NULL').run(id, hash);
  }

  /** Games stored without a number, which happens when one arrives mid-round. */
  withoutIds(): GameRow[] {
    const rows = this.db
      .prepare(
        `SELECT hash, id, bust, forced_at, ended_at, ts_source
         FROM games WHERE id IS NULL ORDER BY ended_at ASC`,
      )
      .all() as unknown as RawRow[];
    return rows.map(toRow);
  }

  byHash(hash: string): GameRow | null {
    const row = this.db
      .prepare(
        `SELECT hash, id, bust, forced_at, ended_at, ts_source FROM games WHERE hash = ?`,
      )
      .get(hash) as RawRow | undefined;
    return row ? toRow(row) : null;
  }

  /** The next few games after a moment, used to find a game's successor. */
  after(endedAt: number, limit: number): GameRow[] {
    const rows = this.db
      .prepare(
        `SELECT hash, id, bust, forced_at, ended_at, ts_source
         FROM games WHERE ended_at > ? ORDER BY ended_at ASC LIMIT ?`,
      )
      .all(Math.round(endedAt), limit) as unknown as RawRow[];
    return rows.map(toRow);
  }

  has(hash: string): boolean {
    return this.db.prepare('SELECT 1 FROM games WHERE hash = ?').get(hash) !== undefined;
  }

  /** The most recently ended game, which is what a new frame must chain onto. */
  latest(): GameRow | null {
    const row = this.db
      .prepare(
        `SELECT hash, id, bust, forced_at, ended_at, ts_source
         FROM games ORDER BY ended_at DESC, rowid DESC LIMIT 1`,
      )
      .get() as RawRow | undefined;
    return row ? toRow(row) : null;
  }

  /** The newest game whose id is known, used as a backfill anchor. */
  latestWithId(): GameRow | null {
    const row = this.db
      .prepare(
        `SELECT hash, id, bust, forced_at, ended_at, ts_source
         FROM games WHERE id IS NOT NULL ORDER BY id DESC LIMIT 1`,
      )
      .get() as RawRow | undefined;
    return row ? toRow(row) : null;
  }

  /** The oldest stored game, where a backfill continues from. */
  earliestWithId(): GameRow | null {
    const row = this.db
      .prepare(
        `SELECT hash, id, bust, forced_at, ended_at, ts_source
         FROM games WHERE id IS NOT NULL ORDER BY id ASC LIMIT 1`,
      )
      .get() as RawRow | undefined;
    return row ? toRow(row) : null;
  }

  /** Games in a half-open time window, oldest first. */
  range(from: number, to: number, limit: number): Game[] {
    const rows = this.db
      .prepare(
        `SELECT hash, id, bust, forced_at, ended_at, ts_source
         FROM games WHERE ended_at >= ? AND ended_at < ?
         ORDER BY ended_at ASC LIMIT ?`,
      )
      .all(Math.round(from), Math.round(to), limit) as unknown as RawRow[];
    return rows.map(toGame);
  }

  /**
   * Every game in play order. Used by the run scanner, which needs the whole
   * sequence at once because a run can start anywhere.
   */
  allOrderedById(): Array<{ id: number; bust: number; ended_at: number; ts_source: string }> {
    return this.db
      .prepare('SELECT id, bust, ended_at, ts_source FROM games WHERE id IS NOT NULL ORDER BY id')
      .all() as unknown as Array<{
      id: number;
      bust: number;
      ended_at: number;
      ts_source: string;
    }>;
  }

  countInRange(from: number, to: number): number {
    const row = this.db
      .prepare('SELECT COUNT(*) AS n FROM games WHERE ended_at >= ? AND ended_at < ?')
      .get(Math.round(from), Math.round(to)) as { n: number };
    return row.n;
  }

  stats(): Stats {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS n, MIN(ended_at) AS oldest, MAX(ended_at) AS newest, MAX(id) AS latestId
         FROM games`,
      )
      .get() as { n: number; oldest: number | null; newest: number | null; latestId: number | null };
    return {
      gamesStored: row.n,
      oldest: row.oldest,
      newest: row.newest,
      latestId: row.latestId,
    };
  }
}

/** True for a UNIQUE violation on the id column specifically. */
function isIdConflict(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /UNIQUE constraint failed: games\.id/i.test(message);
}

interface RawRow {
  hash: string;
  id: number | null;
  bust: number;
  forced_at: number | null;
  ended_at: number;
  ts_source: string;
}

function toRow(row: RawRow): GameRow {
  return {
    hash: row.hash,
    id: row.id,
    bust: row.bust,
    forcedAt: row.forced_at,
    endedAt: row.ended_at,
    tsSource: row.ts_source as TsSource,
  };
}

function toGame(row: RawRow): Game {
  return {
    id: row.id,
    bust: row.bust,
    hash: row.hash,
    endedAt: row.ended_at,
    tsSource: row.ts_source as TsSource,
  };
}
