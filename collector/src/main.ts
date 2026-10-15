import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig, log, logError } from './config.ts';
import { GameStore } from './db.ts';
import { decodeGameEnded, decodeGameStarting } from './decode.ts';
import { describeTable, tryReadRoot } from './fb.ts';
import { linkMissingIds, Recorder } from './recorder.ts';
import { startApiServer } from './api.ts';
import { BustabitClient } from './ws-client.ts';
import { BrowserSource, findBrowser } from './browser-transport.ts';
import { parseTransport, type GameSource } from './source.ts';
import { formatBust } from '../../shared/stats.ts';

/**
 * Collector entrypoint.
 *
 * Watches bustabit, stamps each finished game with the local time it arrived,
 * verifies it against the provably-fair math, stores it, and serves the
 * dashboard's API.
 *
 * Flags:
 *   --dump               write every frame to data/frames and describe its fields
 *   --transport=direct   speak the protocol from Node instead of driving a browser
 */

const config = loadConfig();
const dumpMode = process.argv.includes('--dump');
const transportArg = process.argv
  .find((arg) => arg.startsWith('--transport='))
  ?.split('=')[1];
const transport = parseTransport(transportArg, config.transport);

const store = new GameStore(config.dbPath);
const recorder = new Recorder(store, {
  maxHealSteps: config.maxHealSteps,
  verifierSamples: config.verifierSamples,
});

const source = createSource();
const startedAt = Date.now();
let dumped = 0;

function createSource(): GameSource {
  if (transport === 'direct') {
    log('transport: direct (speaking the protocol from Node)');
    const token = store.getMeta('client_token') ?? undefined;
    const client = new BustabitClient(config, token);
    store.setMeta('client_token', client.clientToken);
    return client;
  }

  const browserPath = findBrowser(config.browserPath || undefined);
  if (!browserPath) {
    logError(
      'no Chrome or Edge found. Install one, or set BUSTABIT_BROWSER_PATH, ' +
        'or run with --transport=direct.',
    );
    process.exit(1);
  }
  log('transport: browser (bustabit refuses direct connections from Node)');
  return new BrowserSource(config, browserPath);
}

if (dumpMode) {
  mkdirSync(config.framesDir, { recursive: true });
  log(`discovery mode: writing raw frames to ${config.framesDir}`);
}

source.on('state', (state) => log(`state: ${state}`));
source.on('fatal', (reason) => logError(`stopped: ${reason}`));

source.on('frame', (kind, label, payload) => {
  if (!dumpMode) return;
  const name = `${Date.now()}-${dumped++}-${kind}-${sanitize(label)}.bin`;
  writeFileSync(join(config.framesDir, name), payload);
  describeFrame(kind, label, payload);
});

source.on('event', (name, payload) => {
  switch (name) {
    case 'gameStarting': {
      const decoded = decodeGameStarting(payload);
      if (decoded?.id != null) recorder.noteGameStarting(decoded.id);
      break;
    }
    case 'gameEnded':
      onGameEnded(payload);
      break;
    default:
      break;
  }
});

function onGameEnded(payload: Buffer): void {
  const decoded = decodeGameEnded(payload);
  if (!decoded) {
    logError('could not decode a gameEnded frame; run with --dump to inspect it');
    return;
  }

  const result = recorder.recordGameEnded(decoded);
  switch (result.outcome) {
    case 'stored': {
      const id = result.row?.id;
      const healed = result.healed > 0 ? `, recovered ${result.healed} missed` : '';
      log(`game ${id ?? '?'} busted at ${formatBust(decoded.bust)}${healed}`);
      break;
    }
    case 'decode-mismatch':
      logError(
        `frame rejected: bust ${decoded.bust} does not match hash ${decoded.hash.slice(0, 16)}...` +
          ' The decode or the salt is wrong, so nothing was stored.',
      );
      break;
    case 'invalid':
      logError('frame rejected: the hash or bust was not usable');
      break;
    case 'duplicate':
      break;
  }
}

/** Print every field slot of a frame with each plausible reading. */
function describeFrame(kind: string, label: string, payload: Buffer): void {
  const table = tryReadRoot(payload);
  if (!table) {
    log(`  ${kind} ${label}: ${payload.length} bytes, not a flatbuffers table`);
    return;
  }
  log(`  ${kind} ${label}: ${payload.length} bytes, ${table.fieldCount} field slots`);
  for (const field of describeTable(table)) {
    const notes = [
      field.looksLikeGameHash ? 'HASH' : null,
      field.looksLikeMsEpoch ? 'MS-EPOCH' : null,
      field.looksLikeBust ? 'BUST?' : null,
    ]
      .filter(Boolean)
      .join(' ');
    log(
      `    [${field.index}] f64=${fmt(field.asF64)} i64=${field.asI64 ?? '-'} ` +
        `str=${field.asString ? truncate(field.asString) : '-'} ${notes}`,
    );
  }
}

function fmt(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return '-';
  return Math.abs(value) > 1e12 ? value.toExponential(3) : String(Number(value.toFixed(6)));
}

function truncate(value: string): string {
  return value.length > 24 ? `${value.slice(0, 20)}...` : value;
}

function sanitize(label: string): string {
  return label.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 40) || 'none';
}

const api = startApiServer({ config, store, recorder, source, startedAt });

const stats = store.stats();
if (stats.gamesStored > 0) {
  log(`database holds ${stats.gamesStored} games, newest id ${stats.latestId ?? '?'}`);
}

// Games seen mid-round arrive without a number; the chain supplies it once a
// neighbour is stored.
const numbered = linkMissingIds(store);
if (numbered > 0) log(`numbered ${numbered} game(s) from the hash chain`);

source.start();

let shuttingDown = false;
function shutdown(signal: string): void {
  if (shuttingDown) return;
  shuttingDown = true;
  log(`${signal}: shutting down`);
  source.stop();
  api.close();
  store.close();
  setTimeout(() => process.exit(0), 300).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
