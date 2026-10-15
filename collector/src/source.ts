import type { CollectorState } from '../../shared/types.ts';

/**
 * The contract both game sources implement, so the collector does not care
 * which one is running.
 *
 * There are two because bustabit sits behind Cloudflare, which fingerprints the
 * TLS handshake and refuses Node's while accepting a browser's. The browser
 * source therefore works today and is the default; the direct source speaks the
 * protocol itself and is kept because it is the real client protocol and works
 * wherever that fingerprinting does not apply.
 */

export interface SourceEvents {
  /** A server push: the event name and its FlatBuffers payload. */
  event: [name: string, payload: Buffer];
  state: [state: CollectorState];
  /** Every frame, for discovery mode. */
  frame: [kind: string, label: string, payload: Buffer];
  /** The source stopped for a reason restarting will not fix. */
  fatal: [reason: string];
  ready: [];
}

export interface GameSource {
  readonly state: CollectorState;
  readonly connected: boolean;
  readonly fatalReason: string | null;
  start(): void;
  stop(): void;
  on<K extends keyof SourceEvents>(
    event: K,
    listener: (...args: SourceEvents[K]) => void,
  ): unknown;
}

export type TransportName = 'browser' | 'direct';

export function parseTransport(value: string | undefined, fallback: TransportName): TransportName {
  if (value === 'browser' || value === 'direct') return value;
  return fallback;
}
