/**
 * Bustabit's wire framing, separated from the socket so it can be tested.
 *
 * A request is the ASCII header `method:id:` followed by a FlatBuffers payload.
 * A response starts with one marker byte: 'R' for an RPC result, 'E' for an RPC
 * error, '.' for a server push. The marker is followed by the request id (for
 * R/E) or the event name (for '.'), a colon, then the payload.
 */

export const MARKER_RESULT = 0x52; // 'R'
export const MARKER_ERROR = 0x45; // 'E'
export const MARKER_EVENT = 0x2e; // '.'
const COLON = 0x3a;

export type Frame =
  | { kind: 'result'; id: string; payload: Buffer }
  | { kind: 'error'; id: string; payload: Buffer }
  | { kind: 'event'; name: string; payload: Buffer };

export function encodeRequest(method: string, id: number | string, payload?: Buffer): Buffer {
  const header = Buffer.from(`${method}:${id}:`, 'utf8');
  return payload && payload.length > 0 ? Buffer.concat([header, payload]) : header;
}

/**
 * Split a binary frame into its marker, label and payload.
 * Returns null for anything that does not match the framing, so unknown traffic
 * is logged rather than misinterpreted.
 */
export function decodeFrame(buf: Buffer): Frame | null {
  if (buf.length < 2) return null;
  const marker = buf[0]!;
  if (marker !== MARKER_RESULT && marker !== MARKER_ERROR && marker !== MARKER_EVENT) return null;

  const colon = buf.indexOf(COLON, 1);
  if (colon < 0) return null;

  const label = buf.toString('ascii', 1, colon);
  const payload = buf.subarray(colon + 1);

  if (marker === MARKER_EVENT) {
    return label.length === 0 ? null : { kind: 'event', name: label, payload };
  }
  return {
    kind: marker === MARKER_RESULT ? 'result' : 'error',
    id: label,
    payload,
  };
}

/** The handshake reply: solved counter, client version, client token, secret. */
export function encodeHandshake(
  counter: number,
  clientVersion: string,
  clientToken: string,
  secret = '',
): string {
  return `${counter}:${clientVersion}:${clientToken}:${secret}`;
}

/** Handshake rejections the server sends as plain text. */
export const HANDSHAKE_REJECTIONS = ['OUTDATED_CLIENT', 'TOO_MANY_CLIENTS'] as const;
export type HandshakeRejection = (typeof HANDSHAKE_REJECTIONS)[number];

export function asRejection(text: string): HandshakeRejection | null {
  const trimmed = text.trim();
  return (HANDSHAKE_REJECTIONS as readonly string[]).includes(trimmed)
    ? (trimmed as HandshakeRejection)
    : null;
}

/** A challenge is the hex string the server pushes before anything else. */
export function looksLikeChallenge(text: string): boolean {
  return /^[0-9a-f]{4,}$/i.test(text.trim());
}
