import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
export const PROJECT_ROOT = resolve(here, '../..');

function env(name: string, fallback: string): string {
  const value = process.env[name];
  return value === undefined || value === '' ? fallback : value;
}

function envInt(name: string, fallback: number): number {
  const value = process.env[name];
  if (value === undefined || value === '') return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export interface Config {
  /**
   * How games are collected. 'browser' drives a real Chrome, which is the only
   * thing bustabit's Cloudflare fingerprinting lets through from this machine.
   * 'direct' speaks the protocol from Node and is kept for networks where that
   * check does not apply.
   */
  transport: 'browser' | 'direct';
  wsUrl: string;
  /** The page the browser transport opens. */
  siteUrl: string;
  /** Path to Chrome or Edge. Empty means search the usual locations. */
  browserPath: string;
  /** Reload the page if no game traffic arrives for this long. */
  browserIdleMs: number;
  /**
   * Client version sent in the handshake. Bustabit pins this and answers
   * OUTDATED_CLIENT when it no longer matches, so it is configurable to let a
   * bump be applied without touching code.
   */
  clientVersion: string;
  /** Sent because the server rejects curl-like agents outright. */
  userAgent: string;
  /**
   * Origin header. Empty means send none, which is what a non-browser client
   * should do: the server rejects a foreign Origin but accepts its absence.
   */
  origin: string;
  apiPort: number;
  apiHost: string;
  dbPath: string;
  framesDir: string;
  /** How long the API will serve, capped so one request cannot read everything. */
  maxRowsPerRequest: number;
  pingIntervalMs: number;
  /** Reconnect if nothing at all arrives for this long. */
  watchdogMs: number;
  reconnectMinMs: number;
  reconnectMaxMs: number;
  /** How far back to walk the chain when healing a gap after a disconnect. */
  maxHealSteps: number;
  /** Games to collect before the verifier encoding is pinned. */
  verifierSamples: number;
  rpcTimeoutMs: number;
}

export function loadConfig(): Config {
  return {
    transport: env('BUSTABIT_TRANSPORT', 'browser') === 'direct' ? 'direct' : 'browser',
    wsUrl: env('BUSTABIT_WS_URL', 'wss://gs.bustabit.com/ws'),
    siteUrl: env('BUSTABIT_SITE_URL', 'https://bustabit.com/'),
    browserPath: env('BUSTABIT_BROWSER_PATH', ''),
    browserIdleMs: envInt('BROWSER_IDLE_MS', 180_000),
    clientVersion: env('BUSTABIT_CLIENT_VERSION', '30'),
    userAgent: env(
      'BUSTABIT_USER_AGENT',
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
    ),
    origin: env('BUSTABIT_ORIGIN', ''),
    apiPort: envInt('API_PORT', 8787),
    apiHost: env('API_HOST', '127.0.0.1'),
    dbPath: env('DB_PATH', resolve(PROJECT_ROOT, 'data/bustabit.db')),
    framesDir: env('FRAMES_DIR', resolve(PROJECT_ROOT, 'data/frames')),
    maxRowsPerRequest: envInt('MAX_ROWS', 100_000),
    pingIntervalMs: envInt('PING_INTERVAL_MS', 7_000),
    watchdogMs: envInt('WATCHDOG_MS', 30_000),
    reconnectMinMs: envInt('RECONNECT_MIN_MS', 1_000),
    reconnectMaxMs: envInt('RECONNECT_MAX_MS', 60_000),
    maxHealSteps: envInt('MAX_HEAL_STEPS', 10_000),
    verifierSamples: envInt('VERIFIER_SAMPLES', 3),
    rpcTimeoutMs: envInt('RPC_TIMEOUT_MS', 15_000),
  };
}

/** Timestamp-prefixed logger, so a long-running collector leaves a readable trail. */
export function log(...args: unknown[]): void {
  console.log(new Date().toISOString(), ...args);
}

export function logError(...args: unknown[]): void {
  console.error(new Date().toISOString(), ...args);
}
