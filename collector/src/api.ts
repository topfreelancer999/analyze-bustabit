import { createServer, type Server } from 'node:http';
import type { Config } from './config.ts';
import { log } from './config.ts';
import type { GameStore } from './db.ts';
import type { Recorder } from './recorder.ts';
import type { GameSource } from './source.ts';
import type { GamesResponse, StatusResponse } from '../../shared/types.ts';

/**
 * The dashboard's read-only API, served from the collector process so there is
 * one owner of the database. Vite proxies /api here in development.
 */

export interface ApiDeps {
  config: Config;
  store: GameStore;
  recorder: Recorder;
  source: GameSource;
  /** When the collector process started, for the status panel. */
  startedAt: number;
}

const DAY_MS = 86_400_000;

export function createApiServer(deps: ApiDeps): Server {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 'no-store');

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return send(res, 405, { error: 'method not allowed' });
    }

    try {
      switch (url.pathname) {
        case '/api/status':
          return send(res, 200, buildStatus(deps));
        case '/api/games':
          return send(res, 200, buildGames(deps, url));
        case '/api/health':
          return send(res, 200, { ok: true });
        default:
          return send(res, 404, { error: 'not found' });
      }
    } catch (error) {
      return send(res, 500, { error: (error as Error).message });
    }
  });

  return server;
}

export function startApiServer(deps: ApiDeps): Server {
  const server = createApiServer(deps);
  server.listen(deps.config.apiPort, deps.config.apiHost, () => {
    log(`api listening on http://${deps.config.apiHost}:${deps.config.apiPort}`);
  });
  return server;
}

function buildStatus(deps: ApiDeps): StatusResponse {
  const stats = deps.store.stats();
  return {
    connected: deps.source.connected,
    state: deps.source.state,
    fatal: deps.source.fatalReason,
    clientVersion: deps.config.clientVersion,
    lastGameAt: stats.newest,
    lastGameId: stats.latestId,
    gamesStored: stats.gamesStored,
    oldest: stats.oldest,
    newest: stats.newest,
    decodeErrors: deps.recorder.counters.decodeErrors,
    chainBreaks: deps.recorder.counters.chainBreaks,
    gamesHealed: deps.recorder.counters.gamesHealed,
    verifierMode: deps.recorder.verifierMode,
    serverTime: Date.now(),
  };
}

function buildGames(deps: ApiDeps, url: URL): GamesResponse {
  const now = Date.now();
  const to = numberParam(url, 'to') ?? now;
  const from = numberParam(url, 'from') ?? to - DAY_MS;
  if (!Number.isFinite(from) || !Number.isFinite(to)) {
    throw new Error('from and to must be millisecond timestamps');
  }
  if (to < from) throw new Error('to must not be before from');

  const limit = deps.config.maxRowsPerRequest;
  const games = deps.store.range(from, to, limit);
  return { games, from, to, truncated: games.length >= limit };
}

function numberParam(url: URL, name: string): number | null {
  const raw = url.searchParams.get(name);
  if (raw === null || raw === '') return null;
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new Error(`${name} must be a number`);
  return value;
}

function send(res: import('node:http').ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(json),
  });
  res.end(json);
}
