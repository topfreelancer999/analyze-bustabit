import { useEffect, useRef, useState } from 'react';
import { fetchGames, fetchStatus } from '../api/client.ts';
import type { Game, StatusResponse } from '@shared/types.ts';

/**
 * Polling hooks for the two endpoints.
 *
 * Both keep the previous value while a refresh is in flight, so the dashboard
 * does not blank out every few seconds, and both surface the error rather than
 * silently showing stale data as if it were fresh.
 */

export interface Polled<T> {
  data: T | null;
  error: string | null;
  loading: boolean;
}

export function useStatus(intervalMs = 5_000): Polled<StatusResponse> {
  const [state, setState] = useState<Polled<StatusResponse>>({
    data: null,
    error: null,
    loading: true,
  });

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();

    const tick = async () => {
      try {
        const data = await fetchStatus(controller.signal);
        if (!cancelled) setState({ data, error: null, loading: false });
      } catch (error) {
        if (cancelled || controller.signal.aborted) return;
        setState((prev) => ({ ...prev, error: (error as Error).message, loading: false }));
      }
    };

    void tick();
    const timer = setInterval(tick, intervalMs);
    return () => {
      cancelled = true;
      controller.abort();
      clearInterval(timer);
    };
  }, [intervalMs]);

  return state;
}

export interface GamesState extends Polled<Game[]> {
  truncated: boolean;
}

export function useGames(from: number, to: number, intervalMs = 15_000): GamesState {
  const [state, setState] = useState<GamesState>({
    data: null,
    error: null,
    loading: true,
    truncated: false,
  });
  // Keeps the effect from re-subscribing on every render when the window is stable.
  const windowRef = useRef({ from, to });
  windowRef.current = { from, to };

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    setState((prev) => ({ ...prev, loading: true }));

    const tick = async () => {
      try {
        const response = await fetchGames(from, to, controller.signal);
        if (!cancelled) {
          setState({
            data: response.games,
            error: null,
            loading: false,
            truncated: response.truncated,
          });
        }
      } catch (error) {
        if (cancelled || controller.signal.aborted) return;
        setState((prev) => ({ ...prev, error: (error as Error).message, loading: false }));
      }
    };

    void tick();
    const timer = setInterval(tick, intervalMs);
    return () => {
      cancelled = true;
      controller.abort();
      clearInterval(timer);
    };
  }, [from, to, intervalMs]);

  return state;
}
