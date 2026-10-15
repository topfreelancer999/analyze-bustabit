# Bustabit Hourly Bust Analyzer — Implementation Plan

## Context

`d:\tasks\analyze-bustabit` contains only a README asking for Bustabit "bust" multipliers grouped per hour of the day (`00:00 - 00:59 -> 1.1x, 0.5x, 2.1x, ...`). The user wants a simple Vite + React + TypeScript dashboard that fetches values live from bustabit.com, with distribution/threshold stats, streak analysis, and charts (histogram, timeline).

Research findings (verified against the live site bundle and `github.com/bustabit/verifier`) that shape the design:

- **No HTTP API, no scrapeable HTML.** The only data source is a binary FlatBuffers WebSocket `wss://gs.bustabit.com/ws`, with a hashcash proof-of-work handshake and a pinned client version string (`30`).
- **Timestamps are not in the game data.** The `gameEnded` push carries only `{bust, forcedAt, hash}`. Historical timestamps exist only through a per-game `getGameInfo` RPC. A collector must therefore stamp games locally as they happen; history before the collector starts is only available via optional backfill.
- **Busts are deterministic** from a SHA-256 hash chain (`hash(N-1) = sha256(rawBytes(hash(N)))`) and a public salt (`GAME_SALT = 00000000000000000001e08b7fd44f95e3e950ac65650a8031a6d5e1750e34be`, games > 12,279,450). Formula: HMAC-SHA256(salt, hash) → 52 msb → `X = 99/(1-X)` → `max(1, floor(X)/100)`. This gives a free correctness check on every decoded frame.
- **Minimum bust is 1.00x** (instant bust, 1% of games). The README's `0.5x`/`0.3x` examples cannot occur; thresholds start at 1.00x/1.10x.
- **Access rules:** 403 for a non-bustabit `Origin` header (Node clients send none: fine) and 403 for curl-like User-Agents (send a browser-like UA). Rate limits undocumented.
- **Cadence:** ~22 s/game, ~160 games/hour, ~3,900/day.
- **Caveat to show in the UI:** busts derive from a hash chain committed in Feb 2024 plus a Bitcoin block hash, so they are provably independent of wall-clock time. Hour-of-day differences are noise by construction; the dashboard shows fair-RNG expected values next to observed ones.
- Environment: Windows 11, Node v25.8.1 (has `node:sqlite`, native TS type stripping), npm 11, no pnpm.

## Key decisions

| Decision | Choice | Why |
|---|---|---|
| Repo shape | One `package.json`, folders `collector/`, `web/`, `shared/`; no workspaces | One install; Vite/Vitest resolve `shared/` via alias |
| Storage | SQLite via `node:sqlite` (`data/bustabit.db`) | No native builds on Node 25/Windows; range queries; dedup |
| Serving data | Tiny `node:http` JSON API inside the collector (port 8787); Vite proxies `/api` | Single long-running process, no Express |
| Collector runtime | `node --watch collector/src/main.ts` (type stripping; fallback `tsx`) | No build step |
| WebSocket | `ws` package | Needs custom `User-Agent`, no `Origin`; global WebSocket can't set headers |
| FlatBuffers | Hand-rolled ~80-line table reader, field indices pinned after a discovery pass | Only 3 tables, schemas unpublished, avoids `flatc` on Windows |
| Stats | Pure functions in `shared/stats.ts`, computed client-side, Vitest-tested | Week of games ≈ 27k rows, trivial for the browser |
| Charts | Recharts, one series per chart, log scale for busts | Follow `dataviz` skill when implementing |

## Layout

```
analyze-bustabit/
  package.json, tsconfig.json, tsconfig.collector.json, vite.config.ts, vitest.config.ts, .gitignore
  README.md                       extend with run instructions + caveats
  data/                           bustabit.db, frames/ (gitignored)
  shared/
    types.ts                      Game, StatusResponse, GamesResponse
    expected.ts                   fair-RNG reference: P(bust >= t) = 0.99 / t
    stats.ts, stats.test.ts       pure analysis functions
  collector/src/
    main.ts                       entry: config, db, ws client, http api; --dump flag
    config.ts                     WS_URL, CLIENT_VERSION (default 30), API_PORT, DB_PATH, USER_AGENT
    hashcash.ts                   solve(challenge) -> counter
    ws-client.ts                  state machine, framing, RPC map, ping, reconnect
    fb.ts                         minimal FlatBuffers reader (root, vtable, f64/i64/str/table/vector)
    decode.ts                     decodeGameEnded / decodeGameInfo / decodeGameStarting (pinned indices)
    verify.ts                     gameResult(hash), prevHash(hash), GAME_SALT, SALT_BOUNDARY_ID
    db.ts                         schema, insertGame, queryRange, status, meta
    api.ts                        GET /api/status, GET /api/games?from&to
    backfill.ts                   phase 2 CLI
    *.test.ts, ../fixtures/       captured frames (base64) for decode tests
  web/
    index.html, src/main.tsx, src/App.tsx, src/styles.css
    src/api/client.ts             fetchGames, fetchStatus
    src/hooks/                    useGames (poll 15 s), useStatus (poll 5 s), usePref (localStorage)
    src/components/               StatusBar, Controls, StatTiles, ThresholdTable, HistogramChart,
                                  TimelineChart, HourlyView, HourlyChart
```

Deps: `react`, `react-dom`, `recharts`, `ws`. Dev: `vite`, `@vitejs/plugin-react`, `typescript`, `vitest`, `@types/{node,react,react-dom,ws}`.
Scripts: `collector`, `collector:dump`, `backfill`, `web` (vite), `build`, `test` (vitest run), `typecheck`. Two terminals: collector + web.

## Collector design

**Lifecycle** (`ws-client.ts`): `connecting → awaitingChallenge → solvingPow → handshaking → ready → closed → backoff`.
1. Connect with browser-like `User-Agent`, no `Origin`.
2. First text frame is the hashcash challenge: find `i` such that `sha256(challenge + i)` has `2 * Number(challenge[0])` leading hex zeros (`node:crypto`, synchronous).
3. Send text `${i}:${CLIENT_VERSION}:${clientToken}:` (empty secret = anonymous). `clientToken` is a random 16-byte hex persisted in the `meta` table.
4. Reply handling: `OUTDATED_CLIENT` → log loudly, set fatal status, do not reconnect (user bumps `CLIENT_VERSION` env). `TOO_MANY_CLIENTS` → back off 5 min. Binary → connected state payload (dumped in discovery mode).
5. Ready: text `ping:${id}:` every 7 s; watchdog closes after 30 s silence; reconnect with exponential backoff 1 s → 60 s plus jitter.

**Framing:** request = UTF-8 `${method}:${id}:` + FlatBuffers bytes; pending map with 15 s timeout. Response byte 0 is `R` | `E` | `.`, then ASCII id/event name up to `:`, then payload.

**Decoding** (`fb.ts`, `decode.ts`): expected field order `gameEnded {bust:0, forcedAt:1, hash:2}`, `StrippedGameInfo {id, bust, hash, forcedAt}`, `GameInfo {stripped, bets, commission, created}`. Confirm via `--dump` discovery (save raw frames to `data/frames/`, print each slot as f64/i64/string). Check in one `gameEnded` and one `getGameInfo` frame as fixtures.

**Self-checks** (`verify.ts`, port of verifier `src/utils/math.ts`): for every frame, `gameResult(hash) === bust` (2-decimal compare) else log, count in status, and do not insert. The HMAC input encoding (hex-string bytes vs raw bytes) is auto-selected against the first live frames and then pinned in `meta`. Chain check: `prevHash(newHash)` must equal the last stored hash; if not, walk back (≤10k steps) to the stored hash, regenerate missed busts, insert with `ts_source='interp'` and interpolated timestamps. This makes the collector self-healing across outages.

**Identity and timestamps:** `hash` is the primary key (`gameEnded` has no id). `id` is stored when known (from `gameStarting`/state, confirmed in discovery; else derived as `anchorId - steps`). `ended_at = Date.now()` on receipt (`ts_source='live'`). `INSERT OR IGNORE`.

**Schema:**
```sql
PRAGMA journal_mode = WAL;
CREATE TABLE games (hash TEXT PRIMARY KEY, id INTEGER UNIQUE, bust REAL NOT NULL, forced_at REAL,
  ended_at INTEGER NOT NULL, ts_source TEXT NOT NULL CHECK (ts_source IN ('live','rpc','interp')),
  seen_at INTEGER NOT NULL);
CREATE INDEX games_ended_at ON games(ended_at);
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);  -- client_token, verifier_mode, anchor_id
```

**API** (`api.ts`): `GET /api/status` → `{connected, state, fatal, lastGameAt, gamesStored, oldest, newest, decodeErrors, chainBreaks, clientVersion}`; `GET /api/games?from&to` → `{games: Game[]}` ordered by `ended_at`, default last 24 h, cap 100k rows.

## Phase 2 (optional, separate CLI): backfill

1. Anchor on the newest row with known `id` + `hash`; abort if none (run live collector first).
2. Walk the chain backwards N games (`npm run backfill -- --games 20000`), computing bust and `id = anchor - steps`; stop at `id <= 12,279,450` (salt boundary) or at an existing hash.
3. Every 500 games call `getGameInfo(id)` (1.5 s spacing, stop on `E` frames); assert returned hash equals chain hash; record `created` as anchor (`ts_source='rpc'`).
4. Interpolate between anchors with `duration_ms(bust) = 14427 * ln(bust) + 8000`, scaled to the real gap; `ts_source='interp'`. Insert per segment in a transaction; resumable.

## Dashboard

**Pure functions** (`shared/stats.ts`, all tested): `hourOf(ms, tz)`, `groupByHour(games, tz) → 24 buckets {hour, label '00:00 - 00:59', games}`, `thresholdShares(busts, [1.1, 2, 5, 10])` with `expectedShare = 1 - 0.99/t`, `histogram(busts, edges [1,1.1,1.5,2,3,5,10,20,50,100,∞])`, `longestRun(busts, pred)`, `gamesSinceLast(games, t)`, `summary(busts)` (count, median, mean, max, instantBusts; fair median ≈ 1.98x), `hourlyStats(buckets)`, `formatBust`.

**Component tree:**
```
App
  StatusBar        connected dot, games stored, last game, decode errors, fatal banner (OUTDATED_CLIENT)
  Controls         DaySelect (today) | 24h/7d | TzToggle Local/UTC | LowThreshold 1.1/1.5/2
  StatTiles        count, median, share <2x (observed vs expected), longest low run, games since last 10x
  ThresholdTable   t | count below | observed % | expected % | delta
  HistogramChart   BarChart over histogram bins
  TimelineChart    ScatterChart, x=time, y=bust (log), ≥10x marked, tooltip
  HourlyView       README format: 24 rows "00:00 - 00:59 -> 1.10x, 2.31x, ..." + count/median, truncate with "show all"
  HourlyChart      BarChart per hour, metric toggle (count | median | share below threshold), never two y-axes
```
Hooks: `useGames(from,to)` polling 15 s and keeping previous data; `useStatus()` polling 5 s; `usePref` for tz/threshold. Derived stats via `useMemo`. No router/state library. Light/dark via `prefers-color-scheme`. One-line caveat that outcomes are provably random.

## Implementation steps

1. Scaffold configs, `web/index.html`, hello `App.tsx`; verify `npm run web` and `npm test`.
2. `shared/types.ts`, `expected.ts`, `stats.ts` + tests (no network needed).
3. `collector/src/verify.ts` + test (`gameResult` bounds/2 decimals, `prevHash` deterministic 64-hex).
4. `hashcash.ts` + test (synthetic difficulty-2 challenge).
5. `ws-client.ts`, `config.ts`, `main.ts --dump`: connect, PoW, handshake, ping, framing, dump frames. Milestone: `.gameEnded` every ~22 s.
6. `fb.ts` + discovery → pin indices in `decode.ts`; self-check passes on every frame; check in fixtures; `fb.test.ts`, `decode.test.ts`.
7. `db.ts`: schema, inserts, range query, status, meta; wire live inserts; chain-gap healing.
8. `api.ts` two endpoints (Vite proxy from step 1).
9. Web: client, hooks, StatusBar, Controls, HourlyView first (core requirement), then tiles, table, charts, styles.
10. README: run instructions, caveats (client version pin, no history until backfill, ToS note).
11. Phase 2 `backfill.ts`.

## Verification

- **Decode correctness:** over ≥1 hour live (~160 games) `decodeErrors = 0` and `chainBreaks = 0` in `/api/status`; `getGameInfo.created` within seconds of local stamp.
- **Stats:** `npx vitest run` with hand-built arrays: known medians, runs, hour boundaries at 23:59/00:00 in UTC and local (dates built via `Date.UTC`), monotonic threshold shares.
- **Typecheck:** `tsc -p tsconfig.collector.json --noEmit`; `vite build`.
- **End-to-end:** terminal 1 `npm run collector`, terminal 2 `npm run web`, open `http://localhost:5173`: StatusBar connected, count increments every ~22 s, HourlyView shows current hour's busts matching DB rows, Local/UTC toggle shifts rows, `curl http://localhost:8787/api/status` returns JSON.

## Risks and mitigations

| Risk | Mitigation |
|---|---|
| Client version bump → `OUTDATED_CLIENT` | `CLIENT_VERSION` env; fatal banner in UI; no reconnect storm; rerun `--dump` if payloads change |
| FlatBuffers order / HMAC encoding wrong | Indices pinned after discovery; every frame checked against `gameResult(hash)` and chain continuity; bad decodes dropped and counted |
| Rate limits / ToS | Live mode is one idle socket (like a browser tab); backfill opt-in and throttled; `robots.txt` disallows AI crawlers, so the user should read bustabit's compliance/ToS pages before sustained collection |
| Missed games on disconnect | Chain-gap healing; timestamps flagged `interp` |
| `gameStarting` may not carry id | Hash is the key; id best-effort; fallback binary-search probe via `getGameInfo` |
| Node 25 type-stripping limits | `as const` instead of enums, `.ts` import extensions, fallback `tsx` |
| Windows: SQLite locks, `--watch` restarts | WAL mode, single writer, `SIGINT` closes socket and DB |
| Fair-RNG noise read as patterns | Expected values shown next to observed everywhere |
