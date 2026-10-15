import type { StatusResponse } from '@shared/types.ts';
import { formatDuration } from '@shared/stats.ts';

interface Props {
  status: StatusResponse | null;
  error: string | null;
}

/** Collector health: whether games are still arriving and whether any were rejected. */
export function StatusBar({ status, error }: Props) {
  if (error) {
    return (
      <div className="banner error">
        Cannot reach the collector. Start it with <code>npm run collector</code> in another
        terminal. ({error})
      </div>
    );
  }

  if (!status) {
    return <div className="card status">Checking the collector...</div>;
  }

  const since = status.lastGameAt === null ? null : Date.now() - status.lastGameAt;
  // Games arrive roughly every 22 seconds, so a two-minute silence is notable.
  const stale = since !== null && since > 120_000;

  return (
    <>
      {status.fatal && <div className="banner error">Collector stopped: {status.fatal}</div>}
      <div className="card status">
        <span>
          <span className={`status-dot ${status.connected ? 'on' : 'off'}`} />
          {status.connected ? 'Collecting' : status.state}
        </span>
        <span>
          <strong>{status.gamesStored.toLocaleString()}</strong> games stored
        </span>
        {status.lastGameId !== null && (
          <span>
            latest game <strong>#{status.lastGameId.toLocaleString()}</strong>
          </span>
        )}
        {since !== null && (
          <span className={stale ? 'muted' : undefined}>last seen {formatDuration(since)} ago</span>
        )}
        {status.decodeErrors > 0 && (
          <span>
            <strong>{status.decodeErrors}</strong> frames rejected
          </span>
        )}
        {status.gamesHealed > 0 && (
          <span>
            <strong>{status.gamesHealed}</strong> recovered from the hash chain
          </span>
        )}
      </div>
    </>
  );
}
