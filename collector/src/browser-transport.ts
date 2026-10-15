import { spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import type { Config } from './config.ts';
import { log, logError } from './config.ts';
import { decodeFrame } from './protocol.ts';
import { decodeGameInfo, type DecodedGameInfo } from './decode.ts';
import type { CollectorState } from '../../shared/types.ts';
import type { GameSource, SourceEvents } from './source.ts';

/**
 * Collects games by watching a real browser play the game.
 *
 * Connecting to bustabit directly from Node does not work: Cloudflare
 * fingerprints the TLS handshake and answers 403 to Node's, while accepting a
 * browser's. Rather than impersonate a browser, this drives one. Chrome loads
 * bustabit.com normally and its DevTools protocol hands us every WebSocket
 * frame the page receives, which are the same bytes the direct client would
 * have read. The page also handles the proof-of-work handshake, the client
 * version and reconnects on its own.
 *
 * Nothing is injected into the page and no input is sent: this observes the
 * traffic of an ordinary visit.
 */

const CHROME_CANDIDATES = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
];

export function findBrowser(explicit?: string): string | null {
  if (explicit) return existsSync(explicit) ? explicit : null;
  return CHROME_CANDIDATES.find((path) => existsSync(path)) ?? null;
}

export class BrowserSource extends EventEmitter<SourceEvents> implements GameSource {
  private readonly config: Config;
  private readonly browserPath: string;
  private browser: ChildProcess | null = null;
  private profileDir: string | null = null;
  private cdp: WebSocket | null = null;
  private sessionId: string | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, (result: unknown) => void>();
  private stateValue: CollectorState = 'idle';
  private stopped = false;
  private restartTimer: NodeJS.Timeout | null = null;
  private idleTimer: NodeJS.Timeout | null = null;
  private restartDelay: number;

  fatalReason: string | null = null;

  constructor(config: Config, browserPath: string) {
    super();
    this.config = config;
    this.browserPath = browserPath;
    this.restartDelay = config.reconnectMinMs;
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
    void this.launch();
  }

  stop(): void {
    this.stopped = true;
    this.clearTimers();
    this.closeCdp();
    this.killBrowser();
    this.setState('idle');
  }

  private clearTimers(): void {
    if (this.restartTimer) clearTimeout(this.restartTimer);
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.restartTimer = null;
    this.idleTimer = null;
  }

  private closeCdp(): void {
    if (!this.cdp) return;
    this.cdp.removeAllListeners();
    try {
      this.cdp.close();
    } catch {
      // Already closing.
    }
    this.cdp = null;
    this.sessionId = null;
  }

  private killBrowser(): void {
    if (this.browser) {
      this.browser.removeAllListeners();
      this.browser.kill();
      this.browser = null;
    }
    if (this.profileDir) {
      try {
        rmSync(this.profileDir, { recursive: true, force: true });
      } catch {
        // Chrome may still hold a file; the temp directory will be cleaned by the OS.
      }
      this.profileDir = null;
    }
  }

  private async launch(): Promise<void> {
    if (this.stopped) return;
    this.setState('connecting');
    this.profileDir = mkdtempSync(join(tmpdir(), 'bustabit-collector-'));

    log(`launching browser: ${this.browserPath}`);
    this.browser = spawn(
      this.browserPath,
      [
        '--remote-debugging-port=0',
        `--user-data-dir=${this.profileDir}`,
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-extensions',
        '--disable-background-timer-throttling',
        '--disable-backgrounding-occluded-windows',
        '--disable-renderer-backgrounding',
        '--mute-audio',
        // Keep the window off screen: a real window is required, a visible one is not.
        '--window-position=-32000,-32000',
        '--window-size=1000,800',
        'about:blank',
      ],
      { stdio: 'ignore' },
    );
    this.browser.on('exit', (code) => {
      if (this.stopped) return;
      logError(`browser exited (code ${code})`);
      this.scheduleRestart();
    });

    try {
      const endpoint = await this.readDebuggerUrl();
      await this.attach(endpoint);
    } catch (error) {
      logError('could not attach to the browser:', (error as Error).message);
      this.scheduleRestart();
    }
  }

  /** Chrome writes its chosen port into the profile once it is listening. */
  private async readDebuggerUrl(): Promise<string> {
    const portFile = join(this.profileDir!, 'DevToolsActivePort');
    for (let attempt = 0; attempt < 80; attempt++) {
      if (existsSync(portFile)) {
        const [port] = readFileSync(portFile, 'utf8').split('\n');
        try {
          const res = await fetch(`http://127.0.0.1:${port!.trim()}/json/version`);
          if (res.ok) {
            const info = (await res.json()) as { webSocketDebuggerUrl: string; Browser: string };
            log(`browser ready: ${info.Browser}`);
            return info.webSocketDebuggerUrl;
          }
        } catch {
          // Not listening yet.
        }
      }
      await delay(250);
    }
    throw new Error('browser never opened its debugging port');
  }

  private async attach(endpoint: string): Promise<void> {
    const cdp = new WebSocket(endpoint, { maxPayload: 256 * 1024 * 1024 });
    this.cdp = cdp;

    cdp.on('message', (raw) => this.onCdpMessage(raw as Buffer));
    cdp.on('error', (error) => logError('devtools socket error:', error.message));
    cdp.on('close', () => {
      if (this.stopped) return;
      logError('devtools socket closed');
      this.scheduleRestart();
    });

    await new Promise<void>((resolve, reject) => {
      cdp.once('open', resolve);
      cdp.once('error', reject);
    });

    const target = (await this.send('Target.createTarget', { url: 'about:blank' })) as {
      targetId: string;
    };
    const attached = (await this.send('Target.attachToTarget', {
      targetId: target.targetId,
      flatten: true,
    })) as { sessionId: string };
    this.sessionId = attached.sessionId;

    await this.send('Network.enable', {}, this.sessionId);
    await this.send('Page.enable', {}, this.sessionId);
    await this.navigate();
  }

  private async navigate(): Promise<void> {
    this.setState('connecting');
    log(`opening ${this.config.siteUrl}`);
    await this.send('Page.navigate', { url: this.config.siteUrl }, this.sessionId!);
    this.armIdleWatchdog();
  }

  private send(method: string, params: unknown, sessionId?: string): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (!this.cdp || this.cdp.readyState !== WebSocket.OPEN) {
        reject(new Error('devtools socket is not open'));
        return;
      }
      const id = this.nextId++;
      this.pending.set(id, resolve);
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`devtools call ${method} timed out`));
      }, 30_000);
      this.pending.set(id, (result) => {
        clearTimeout(timer);
        resolve(result);
      });
      this.cdp.send(JSON.stringify({ id, method, params, sessionId }));
    });
  }

  private onCdpMessage(raw: Buffer): void {
    let message: CdpMessage;
    try {
      message = JSON.parse(raw.toString('utf8')) as CdpMessage;
    } catch {
      return;
    }

    if (message.id !== undefined) {
      const resolve = this.pending.get(message.id);
      if (resolve) {
        this.pending.delete(message.id);
        resolve(message.result ?? null);
      }
      return;
    }

    switch (message.method) {
      case 'Network.webSocketFrameReceived':
        this.onWsFrame(message.params as WsFrameParams);
        break;
      case 'Network.responseReceived':
        this.onHttpResponse(message.params as ResponseParams);
        break;
      case 'Inspector.targetCrashed':
        if (this.stopped) break;
        logError('the page crashed, restarting the browser');
        this.scheduleRestart();
        break;
      default:
        break;
    }
  }

  private onHttpResponse(params: ResponseParams): void {
    const { url, status } = params.response ?? {};
    if (!url || !url.startsWith(this.config.siteUrl)) return;
    if (status === 403) {
      this.fatalReason =
        'bustabit answered 403 to the browser as well. The site may be blocking this ' +
        'network or the browser profile. Nothing can be collected until that clears.';
      logError(this.fatalReason);
      this.setState('fatal');
      this.emit('fatal', this.fatalReason);
    }
  }

  /**
   * Read one historical game.
   *
   * Opening a game in the site makes it call getGameInfo, whose reply carries
   * the creation time: the only timestamp bustabit exposes for a past game.
   * The route is changed inside the page rather than by loading a new URL,
   * which keeps the existing connection alive and asks the site for no more
   * than a visitor clicking through game history would.
   */
  async fetchGameInfo(id: number, timeoutMs = 20_000): Promise<DecodedGameInfo | null> {
    if (!this.sessionId) throw new Error('browser is not attached');

    const waiter = new Promise<DecodedGameInfo | null>((resolve) => {
      this.gameInfoWaiter = { id, resolve };
      setTimeout(() => {
        if (this.gameInfoWaiter?.id === id) {
          this.gameInfoWaiter = null;
          resolve(null);
        }
      }, timeoutMs);
    });

    await this.send(
      'Runtime.evaluate',
      {
        expression: `(() => {
          history.pushState({}, '', '/game/${id}');
          window.dispatchEvent(new PopStateEvent('popstate', { state: {} }));
        })()`,
        returnByValue: true,
      },
      this.sessionId,
    );
    return waiter;
  }

  private gameInfoWaiter: { id: number; resolve: (info: DecodedGameInfo | null) => void } | null =
    null;

  private onWsFrame(params: WsFrameParams): void {
    const { opcode, payloadData } = params.response;
    // Opcode 1 is text, which is only the proof-of-work handshake the page does
    // for itself. Opcode 2 is binary, which carries every game message.
    if (opcode !== 2 || !payloadData) return;

    const buf = Buffer.from(payloadData, 'base64');
    const frame = decodeFrame(buf);
    if (!frame) {
      this.emit('frame', 'unknown', '', buf);
      return;
    }

    if (!this.connected) {
      this.setState('ready');
      this.restartDelay = this.config.reconnectMinMs;
      this.emit('ready');
    }
    this.armIdleWatchdog();

    this.emit('frame', frame.kind, frame.kind === 'event' ? frame.name : frame.id, frame.payload);
    if (frame.kind === 'event') this.emit('event', frame.name, frame.payload);

    if (frame.kind === 'result' && this.gameInfoWaiter) {
      const info = decodeGameInfo(frame.payload);
      if (info && info.id === this.gameInfoWaiter.id && info.created !== null) {
        const { resolve } = this.gameInfoWaiter;
        this.gameInfoWaiter = null;
        resolve(info);
      }
    }
  }

  /**
   * Reload the page if games stop arriving. The site reconnects on its own, so
   * this only catches the case where it has given up entirely.
   */
  private armIdleWatchdog(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      if (this.stopped || this.stateValue === 'fatal') return;
      logError(`no game traffic for ${this.config.browserIdleMs}ms, reloading the page`);
      this.navigate().catch(() => this.scheduleRestart());
    }, this.config.browserIdleMs);
  }

  private scheduleRestart(): void {
    if (this.stopped || this.restartTimer || this.stateValue === 'fatal') return;
    this.closeCdp();
    this.killBrowser();
    this.setState('backoff');
    const wait = this.restartDelay + Math.floor(Math.random() * 1_000);
    log(`restarting the browser in ${wait}ms`);
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      void this.launch();
    }, wait);
    this.restartDelay = Math.min(this.restartDelay * 2, this.config.reconnectMaxMs);
  }
}

interface CdpMessage {
  id?: number;
  method?: string;
  result?: unknown;
  params?: unknown;
}

interface WsFrameParams {
  response: { opcode: number; payloadData: string };
}

interface ResponseParams {
  response?: { url?: string; status?: number };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
