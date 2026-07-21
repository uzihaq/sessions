import { useEffect, useState } from 'react';
import { fetchServerHealth, listServerSessions } from '../api/sessionsd';
import { formatServerEndpoint } from '../lib/serverEndpoint';
import { useServers, type ServerConfig } from '../lib/servers';
import type { SessionInfo, SessionTool } from '../types';
import { ParserIcon } from './ParserIcon';
import { shortLabel } from './SessionTabs';

const POLL_INTERVAL_MS = 3_000;
const POLL_TIMEOUT_MS = 5_000;

const TOOL_ICONS: Record<SessionTool, string> = {
  'claude-code': '🟠',
  'codex': '🟢',
  'terminal': '⬛'
};

type Reachability = 'checking' | 'reachable' | 'unreachable';

interface ServerSnapshot {
  reachability: Reachability;
  sessions: SessionInfo[];
  sessionsError: string | null;
}

const INITIAL_SNAPSHOT: ServerSnapshot = {
  reachability: 'checking',
  sessions: [],
  sessionsError: null
};

interface FleetViewProps {
  onOpenSession: (serverId: string, sessionId: string) => void;
}

// Fleet is deliberately client-side aggregation: each group owns its own
// polling loop and talks straight to its configured sessionsd. A slow or dead
// machine therefore cannot delay updates from any other machine.
export function FleetView({ onOpenSession }: FleetViewProps): JSX.Element {
  const servers = useServers((state) => state.servers);
  const [includeExited, setIncludeExited] = useState(false);

  return (
    <div className="fleet-view" aria-label="Fleet sessions">
      <div className="fleet-view-heading">
        <div>
          <h1>Fleet</h1>
          <p>Live sessions across {servers.length} {servers.length === 1 ? 'machine' : 'machines'}</p>
        </div>
        <label className="fleet-history-toggle">
          <input type="checkbox" checked={includeExited} onChange={(event) => setIncludeExited(event.target.checked)} />
          Show history
        </label>
      </div>
      <div className="fleet-server-list">
        {servers.map((server) => (
          <FleetServerGroup
            key={server.id}
            server={server}
            includeExited={includeExited}
            onOpenSession={(sessionId) => onOpenSession(server.id, sessionId)}
          />
        ))}
      </div>
    </div>
  );
}

function FleetServerGroup({
  server,
  includeExited,
  onOpenSession
}: {
  server: ServerConfig;
  includeExited: boolean;
  onOpenSession: (sessionId: string) => void;
}): JSX.Element {
  const [snapshot, setSnapshot] = useState<ServerSnapshot>(INITIAL_SNAPSHOT);

  useEffect(() => {
    let stopped = false;
    let pollTimer: number | undefined;
    let controller: AbortController | null = null;

    setSnapshot(INITIAL_SNAPSHOT);

    const poll = async (): Promise<void> => {
      controller = new AbortController();
      const timeout = window.setTimeout(() => controller?.abort(), POLL_TIMEOUT_MS);

      try {
        await fetchServerHealth(server, controller.signal);
      } catch {
        if (!stopped) {
          setSnapshot((current) => ({
            ...current,
            reachability: 'unreachable',
            sessionsError: null
          }));
        }
        window.clearTimeout(timeout);
        if (!stopped) pollTimer = window.setTimeout(() => { void poll(); }, POLL_INTERVAL_MS);
        return;
      }

      if (!stopped) {
        setSnapshot((current) => ({
          ...current,
          reachability: 'reachable',
          sessionsError: null
        }));
      }

      try {
        const sessions = await listServerSessions(server, controller.signal);
        if (!stopped) {
          setSnapshot({ reachability: 'reachable', sessions, sessionsError: null });
        }
      } catch (error) {
        if (!stopped) {
          setSnapshot((current) => ({
            ...current,
            reachability: 'reachable',
            sessionsError: error instanceof Error ? error.message : 'session list unavailable'
          }));
        }
      } finally {
        window.clearTimeout(timeout);
        if (!stopped) pollTimer = window.setTimeout(() => { void poll(); }, POLL_INTERVAL_MS);
      }
    };

    void poll();
    return () => {
      stopped = true;
      controller?.abort();
      window.clearTimeout(pollTimer);
    };
  }, [server]);

  const unavailable = snapshot.reachability === 'unreachable';
  const visibleSessions = includeExited ? snapshot.sessions : snapshot.sessions.filter((session) => !session.exited);
  const activeCount = snapshot.sessions.filter((session) => !session.exited).length;
  const reachabilityLabel = snapshot.reachability === 'reachable'
    ? 'reachable'
    : snapshot.reachability === 'unreachable'
    ? 'unreachable'
    : 'checking';

  return (
    <section className={`fleet-server-group${unavailable ? ' is-unreachable' : ''}`}>
      <header className="fleet-server-header">
        <span
          className={`fleet-reachability-dot is-${snapshot.reachability}`}
          aria-hidden
        />
        <div className="fleet-server-identity">
          <h2>{server.name}</h2>
          <span>{formatServerEndpoint(server)} · {activeCount} active{snapshot.sessions.length > activeCount ? ` · ${snapshot.sessions.length - activeCount} retained` : ''}</span>
        </div>
        <span className={`fleet-reachability-label is-${snapshot.reachability}`}>
          {reachabilityLabel}
        </span>
      </header>

      <div className="fleet-session-list">
        {visibleSessions.map((session) => (
          <FleetSessionRow
            key={session.id}
            session={session}
            disabled={unavailable || session.exited}
            onOpen={() => onOpenSession(session.id)}
          />
        ))}
        {visibleSessions.length === 0 ? (
          <div className="fleet-session-empty">
            {snapshot.reachability === 'checking'
              ? 'Checking machine…'
              : unavailable
              ? 'Session data unavailable'
              : snapshot.sessionsError
              ? snapshot.sessionsError
              : snapshot.sessions.length > 0
              ? 'No active sessions — enable Show history to see retained work'
              : 'No sessions'}
          </div>
        ) : null}
        {snapshot.sessions.length > 0 && snapshot.sessionsError ? (
          <div className="fleet-session-error">Latest session refresh failed: {snapshot.sessionsError}</div>
        ) : null}
      </div>
    </section>
  );
}

function FleetSessionRow({
  session,
  disabled,
  onOpen
}: {
  session: SessionInfo;
  disabled: boolean;
  onOpen: () => void;
}): JSX.Element {
  const state = session.exited ? 'exited' : session.working ? 'working' : 'idle';
  const label = shortLabel(session);
  const cwd = session.cwd.replace(/^\/(Users|home)\/[^/]+/, '~');

  return (
    <button
      type="button"
      className="fleet-session-row"
      disabled={disabled}
      onClick={onOpen}
      aria-label={session.exited ? `${label}, retained history` : `Open ${label}, ${state}`}
    >
      <span className="fleet-session-icon" aria-hidden>
        <ParserIcon icon={TOOL_ICONS[session.tool]} size={18} />
      </span>
      <span className="fleet-session-main">
        <span className="fleet-session-name">{label}</span>
        <span className="fleet-session-cwd">{cwd}</span>
        {session.tags && Object.keys(session.tags).length > 0 ? (
          <span className="fleet-session-tags">
            {Object.entries(session.tags).slice(0, 3).map(([key, value]) => <span key={key}>{key}={value}</span>)}
          </span>
        ) : null}
      </span>
      <span className={`fleet-session-state is-${state}`}>
        <span className="fleet-session-state-dot" aria-hidden />
        {state}
      </span>
    </button>
  );
}
