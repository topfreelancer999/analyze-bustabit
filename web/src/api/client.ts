import type { GamesResponse, StatusResponse } from '@shared/types.ts';

/** Calls the collector's API, proxied by the Vite dev server at /api. */

async function getJson<T>(path: string, signal?: AbortSignal): Promise<T> {
  const res = await fetch(path, { signal, headers: { Accept: 'application/json' } });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? `request failed with status ${res.status}`);
  }
  return (await res.json()) as T;
}

export function fetchStatus(signal?: AbortSignal): Promise<StatusResponse> {
  return getJson<StatusResponse>('/api/status', signal);
}

export function fetchGames(
  from: number,
  to: number,
  signal?: AbortSignal,
): Promise<GamesResponse> {
  const params = new URLSearchParams({ from: String(Math.round(from)), to: String(Math.round(to)) });
  return getJson<GamesResponse>(`/api/games?${params}`, signal);
}
