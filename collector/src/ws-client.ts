import { EventEmitter } from 'node:events';
import { randomBytes } from 'node:crypto';
import WebSocket from 'ws';
import type { Config } from './config.ts';
import { log, logError } from './config.ts';
import { solve } from './hashcash.ts';
import {
  asRejection,
  decodeFrame,
  encodeHandshake,
  encodeRequest,
  looksLikeChallenge,
  type Frame,
} from './protocol.ts';
import type { CollectorState } from '../../shared/types.ts';
import type { GameSource, SourceEvents } from './source.ts';

/**
 * The bustabit game-server connection.
 *
 * Emits 'event' for server pushes, 'state' when the connection state changes,
 * and 'frame' for every raw frame so discovery mode can dump them. RPCs are
 * promise-based and rejected on disconnect rather than left hanging.
 */

export class BustabitClient extends EventEmitter<SourceEvents> implements GameSource {
  private readonly config: Config;
  private ws: WebSocket | null = null;
  private stateValue: CollectorState = 'idle';
  private handshakeDone = false;
  private pingTimer: NodeJS.Timeout | null = null;
  private watchdogTimer: NodeJS.Timeout | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private reconnectDelay: number;
  private connectedSince = 0;
  private nextRequestId = 1;
  private stopped = false;
  private readonly pending = new Map<
    string,
    { resolve: (payload: Buffer) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }
  >();

  readonly clientToken: string;
  fatalReason: string | null = null;

  constructor(config: Config, clientToken?: string) {
    super();
    this.config = config;
    this.reconnectDelay = config.reconnectMinMs;
    this.clientToken = clientToken ?? randomBytes(16).toString('hex');
  }

  get state(): CollectorState {
    return this.stateValue;
  }

  get connected(): boolean {
    return this.stateValue === 'ready';
  }

  private setState(state: CollectorState): void {
    if (this.stateValue === state) return;
    this.stateValue = state;
    this.emit('state', state);
  }

  start(): void {
    this.stopped = false;
    this.connect();
  }

  /** Stop for good. Pending RPCs are rejected and no reconnect is scheduled. */
  stop(): void {
    this.stopped = true;
    this.clearTimers();
    this.rejectPending(new Error('client stopped'));
    if (this.ws) {
      this.ws.removeAllListeners();
      try {
        this.ws.close();
      } catch {
        // Already closing; nothing to do.
      }
      this.ws = null;
    }
    this.setState('idle');
  }

  private connect(): void {
    if (this.stopped) return;
    this.handshakeDone = false;
    this.setState('connecting');

    const headers: Record<string, string> = { 'User-Agent': this.config.userAgent };
    // The server rejects a foreign Origin but accepts a request without one,
    // which is how a non-browser client is expected to connect.
    if (this.config.origin) headers.Origin = this.config.origin;

    log(`connecting to ${this.config.wsUrl}`);
    const ws = new WebSocket(this.config.wsUrl, { headers, handshakeTimeout: 15_000 });
    this.ws = ws;

    ws.on('open', () => {
      this.setState('awaitingChallenge');
      this.armWatchdog();
    });
    ws.on('message', (data, isBinary) => this.onMessage(data as Buffer, isBinary));
    ws.on('error', (error) => logError('socket error:', error.message));
    ws.on('unexpected-response', (_req, res) => {
      logError(`handshake rejected with HTTP ${res.statusCode}`);
      if (res.statusCode === 403) {
        logError('403 usually means the User-Agent or Origin header was refused');
      }
    });
    ws.on('close', (code, reason) => this.onClose(code, reason.toString()));
  }

  private onMessage(data: Buffer, isBinary: boolean): void {
    this.armWatchdog();

    if (!isBinary) {
      this.onText(data.toString('utf8'));
      return;
    }
    if (!this.handshakeDone) {
      // The first binary frame is the connection state, which completes the
      // handshake even though we do not need its contents.
      this.onHandshakeAccepted();
    }
    this.onBinary(data);
  }

  private onText(text: string): void {
    const rejection = asRejection(text);
    if (rejection) {
      this.onRejection(rejection);
      return;
    }

    if (!this.handshakeDone && this.stateValue === 'awaitingChallenge') {
      if (!looksLikeChallenge(text)) {
        logError(`unexpected text before the challenge: ${text.slice(0, 80)}`);
        return;
      }
      this.solveAndReply(text.trim());
      return;
    }

    // Anything else is a text frame we do not model; log it once for discovery.
    this.emit('frame', 'text', '', Buffer.from(text, 'utf8'));
    log(`text frame: ${text.slice(0, 120)}`);
  }

  private solveAndReply(challenge: string): void {
    this.setState('solvingPow');
    let counter: number;
    try {
      const solution = solve(challenge);
      counter = solution.counter;
      log(
        `solved proof of work: difficulty ${solution.difficulty}, ${solution.iterations} iterations, ${solution.ms}ms`,
      );
    } catch (error) {
      logError('proof of work failed:', (error as Error).message);
      this.ws?.close();
      return;
    }

    this.setState('handshaking');
    this.sendText(encodeHandshake(counter, this.config.clientVersion, this.clientToken));
  }

  private onHandshakeAccepted(): void {
    this.handshakeDone = true;
    this.connectedSince = Date.now();
    this.setState('ready');
    this.startPing();
    log('connected');
    this.emit('ready');
  }

  private onRejection(reason: string): void {
    if (reason === 'OUTDATED_CLIENT') {
      this.fatalReason =
        `bustabit rejected client version ${this.config.clientVersion}. ` +
        'Set BUSTABIT_CLIENT_VERSION to the version the site now sends, then restart.';
      logError(this.fatalReason);
      this.setState('fatal');
      this.emit('fatal', this.fatalReason);
      this.stop();
      return;
    }
    // TOO_MANY_CLIENTS: back off hard rather than hammering the server.
    logError(`${reason}: backing off for 5 minutes`);
    this.reconnectDelay = Math.max(this.reconnectDelay, 300_000);
    this.ws?.close();
  }

  private onBinary(data: Buffer): void {
    const frame = decodeFrame(data);
    if (!frame) {
      this.emit('frame', 'unknown', '', data);
      return;
    }
    this.emit('frame', frame.kind, labelOf(frame), frame.payload);

    if (frame.kind === 'event') {
      this.emit('event', frame.name, frame.payload);
      return;
    }

    const pending = this.pending.get(frame.id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(frame.id);
    if (frame.kind === 'result') {
      pending.resolve(frame.payload);
    } else {
      pending.reject(new Error(`server error for request ${frame.id}`));
    }
  }

  /** Call an RPC method and wait for its result frame. */
  request(method: string, payload?: Buffer): Promise<Buffer> {
    if (!this.connected || !this.ws) {
      return Promise.reject(new Error(`not connected (state: ${this.stateValue})`));
    }
    const id = String(this.nextRequestId++);
    return new Promise<Buffer>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`request ${method} timed out after ${this.config.rpcTimeoutMs}ms`));
      }, this.config.rpcTimeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.ws!.send(encodeRequest(method, id, payload));
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error as Error);
      }
    });
  }

  private sendText(text: string): void {
    try {
      this.ws?.send(text);
    } catch (error) {
      logError('failed to send:', (error as Error).message);
    }
  }

  private startPing(): void {
    this.stopPing();
    this.pingTimer = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.sendText(encodeRequest('ping', this.nextRequestId++).toString('utf8'));
      }
    }, this.config.pingIntervalMs);
  }

  private stopPing(): void {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
  }

  /** Drop the connection if the server goes quiet, so a dead socket reconnects. */
  private armWatchdog(): void {
    if (this.watchdogTimer) clearTimeout(this.watchdogTimer);
    this.watchdogTimer = setTimeout(() => {
      logError(`no traffic for ${this.config.watchdogMs}ms, reconnecting`);
      this.ws?.terminate();
    }, this.config.watchdogMs);
  }

  private clearTimers(): void {
    this.stopPing();
    if (this.watchdogTimer) clearTimeout(this.watchdogTimer);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.watchdogTimer = null;
    this.reconnectTimer = null;
  }

  private rejectPending(error: Error): void {
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    this.pending.clear();
  }

  private onClose(code: number, reason: string): void {
    this.clearTimers();
    this.rejectPending(new Error('connection closed'));
    this.ws = null;
    if (this.stopped || this.stateValue === 'fatal') return;

    // A connection that lasted a while is healthy, so start the next backoff fresh.
    const wasStable = this.connectedSince > 0 && Date.now() - this.connectedSince > 300_000;
    if (wasStable) this.reconnectDelay = this.config.reconnectMinMs;
    this.connectedSince = 0;

    const delay = this.reconnectDelay + Math.floor(Math.random() * 1_000);
    log(`disconnected (${code}${reason ? ` ${reason}` : ''}), reconnecting in ${delay}ms`);
    this.setState('backoff');
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, this.config.reconnectMaxMs);
  }
}

function labelOf(frame: Frame): string {
  return frame.kind === 'event' ? frame.name : frame.id;
}
