/** Where a game's timestamp came from. */
export type TsSource =
  /** Stamped locally by the collector the moment the gameEnded frame arrived. */
  | 'live'
  /** Read from getGameInfo(id).created, bustabit's own server timestamp. */
  | 'rpc'
  /** Interpolated between two known anchors using the duration model. */
  | 'interp';

/** One bustabit game as stored and served to the dashboard. */
export interface Game {
  /** Bustabit game number. Null when the collector could not anchor an id. */
  id: number | null;
  /** Crash multiplier, minimum 1.00. */
  bust: number;
  /** Provably-fair game hash, 64 lowercase hex chars. Unique per game. */
  hash: string;
  /** Millisecond epoch the game ended. */
  endedAt: number;
  tsSource: TsSource;
}

export interface GamesResponse {
  games: Game[];
  /** Requested window, echoed back. */
  from: number;
  to: number;
  /** True when the row cap trimmed the result. */
  truncated: boolean;
}

export type CollectorState =
  | 'idle'
  | 'connecting'
  | 'awaitingChallenge'
  | 'solvingPow'
  | 'handshaking'
  | 'ready'
  | 'backoff'
  | 'fatal';

export interface StatusResponse {
  connected: boolean;
  state: CollectorState;
  /** Set when the collector stopped for good, e.g. OUTDATED_CLIENT. */
  fatal: string | null;
  clientVersion: string;
  /** Millisecond epoch of the most recent game seen live, null if none yet. */
  lastGameAt: number | null;
  lastGameId: number | null;
  gamesStored: number;
  oldest: number | null;
  newest: number | null;
  /** Frames whose decoded bust did not match the provably-fair recomputation. */
  decodeErrors: number;
  /** Times the incoming hash did not chain onto the previously stored one. */
  chainBreaks: number;
  /** Games recovered by walking the hash chain after a gap. */
  gamesHealed: number;
  /** Which HMAC input encoding the verifier self-check settled on. */
  verifierMode: string | null;
  serverTime: number;
}
