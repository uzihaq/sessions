import { useEffect, useState } from 'react';
import { fetchServerHealth, listServerProfiles, listServerSessions, type AccountProfile, type ServerHealth } from '../api/sessionsd';
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
  health: ServerHealth | null;
  sessions: SessionInfo[];
  profiles: AccountProfile[];
  sessionsError: string | null;
}

const INITIAL_SNAPSHOT: ServerSnapshot = {
  reachability: 'checking',
  health: null,
  sessions: [],
  profiles: [],
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
      <div className="fleet-section-label"><span>Your machines</span><strong>{servers.length} configured</strong></div>
      <div className="fleet-machine-grid">
        {servers.map((server) => (
          <FleetServerGroup
            key={server.id}
            server={server}
            includeExited={includeExited}
            onOpenSession={(sessionId) => onOpenSession(server.id, sessionId)}
          />
        ))}
        <CloudFleetCard />
      </div>
    </div>
  );
}

function CloudFleetCard(): JSX.Element {
  return (
    <section className="fleet-server-group fleet-cloud-machine" aria-label="Somewhere cloud workspace coming soon">
      <header className="fleet-machine-header">
        <span className="fleet-platform-mark is-cloud" aria-hidden><PlatformIcon platform="cloud" /></span>
        <div className="fleet-server-identity">
          <div className="fleet-machine-title"><h2>Somewhere VM</h2><span className="fleet-machine-badge">Coming soon</span></div>
          <span className="fleet-machine-status"><span className="fleet-reachability-dot" aria-hidden />Not configured</span>
        </div>
      </header>
      <div className="fleet-machine-meta"><span>Cloud workspace</span><span>Outbound-only worker</span></div>
      <div className="fleet-cloud-machine-body">
        <p>An always-on private computer for your sessions, with provider logins isolated inside its own workspace.</p>
        <div><span>Cloud usage</span><span>Encrypted backup</span><span>Scoped files</span></div>
        <button type="button" className="btn" disabled>Set up · coming soon</button>
      </div>
    </section>
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
        const health = await fetchServerHealth(server, controller.signal);
        if (!stopped) {
          setSnapshot((current) => ({ ...current, health }));
        }
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
        const [sessions, profiles] = await Promise.all([
          listServerSessions(server, controller.signal),
          listServerProfiles(server, controller.signal).catch(() => [])
        ]);
        if (!stopped) {
          setSnapshot((current) => ({ ...current, reachability: 'reachable', sessions, profiles, sessionsError: null }));
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
  const profileSummary = snapshot.profiles.reduce<Record<'claude' | 'codex', string[]>>(
    (summary, profile) => {
      summary[profile.tool].push(profile.name);
      return summary;
    },
    { claude: [], codex: [] }
  );
  const profileLabels = [
    profileSummary.claude.length > 0 ? `Claude: ${profileSummary.claude.join(', ')}` : '',
    profileSummary.codex.length > 0 ? `Codex: ${profileSummary.codex.join(', ')}` : ''
  ].filter(Boolean);
  const platform = platformFor(server, snapshot.health);
  const platformText = platformLabel(platform, snapshot.health?.system?.arch);

  return (
    <section className={`fleet-server-group${unavailable ? ' is-unreachable' : ''}`}>
      <header className="fleet-machine-header">
        <span className={`fleet-platform-mark is-${platform}`} aria-hidden><PlatformIcon platform={platform} /></span>
        <div className="fleet-server-identity">
          <div className="fleet-machine-title"><h2>{server.name}</h2>{server.isDefault ? <span className="fleet-machine-badge">This computer</span> : null}</div>
          <span className={`fleet-machine-status is-${snapshot.reachability}`}><span className={`fleet-reachability-dot is-${snapshot.reachability}`} aria-hidden />{reachabilityLabel}</span>
        </div>
        <span className="fleet-machine-count"><strong>{activeCount}</strong> active<span>{snapshot.sessions.length} total</span></span>
      </header>
      <div className="fleet-machine-meta"><span>{platformText}</span><span>{formatServerEndpoint(server)}</span></div>
      {profileLabels.length > 0 ? <div className="fleet-machine-profiles">Accounts · {profileLabels.join(' · ')}</div> : null}

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

type Platform = 'macos' | 'windows' | 'linux' | 'cloud' | 'server';

function platformFor(server: ServerConfig, health: ServerHealth | null): Platform {
  const reported = health?.system?.os.toLowerCase();
  if (reported === 'darwin') return 'macos';
  if (reported === 'windows') return 'windows';
  if (reported === 'linux') return 'linux';

  const hint = `${server.name} ${server.host}`.toLowerCase();
  if (server.isDefault && /mac|darwin/.test(navigator.userAgent.toLowerCase())) return 'macos';
  if (/mac|darwin/.test(hint)) return 'macos';
  if (/windows|win\b/.test(hint)) return 'windows';
  if (/linux|ubuntu|debian|fedora/.test(hint)) return 'linux';
  return 'server';
}

function platformLabel(platform: Platform, arch?: string): string {
  const name = platform === 'macos' ? 'macOS' : platform === 'windows' ? 'Windows' : platform === 'linux' ? 'Linux' : 'Sessions host';
  return arch ? `${name} · ${arch}` : name;
}

function PlatformIcon({ platform }: { platform: Platform }): JSX.Element {
  if (platform === 'macos') {
    return <svg viewBox="0 0 384 512" role="img" aria-label="macOS"><path d="M279.6 258.9c-.2-36.7 16.4-64.4 50-84.8-18.8-26.9-47.2-41.7-84.7-44.6-35.5-2.8-74.3 20.7-88.5 20.7-15 0-49.4-19.7-72.6-19.7C34.4 131.2 0 170.9 0 252.9c0 24.3 4.4 49.4 13.3 75.8 11.9 34.7 54.7 119.8 99.4 118.4 23.4-.6 40-16.6 70.5-16.6 29.6 0 45 16.6 71.1 16.6 45.1-.6 83.8-78.2 95.1-112.9-60.4-28.5-57.3-73.7-69.8-75.3ZM256.4 94.7c27.3-32.4 24.8-61.9 24-72.5-24.1 1.4-52 16.4-67.9 34.9-17.5 19.8-27.8 44.3-25.6 71.9 26.1 2 49.9-11.4 69.5-34.3Z" /></svg>;
  }
  if (platform === 'windows') {
    return <svg viewBox="0 0 24 24" role="img" aria-label="Windows"><path d="m3 4.6 7.5-1v7.8H3V4.6Zm8.6-1.2L21 2v9.4h-9.4v-8ZM3 12.5h7.5v7.8l-7.5-1v-6.8Zm8.6 0H21V22l-9.4-1.4v-8.1Z" /></svg>;
  }
  if (platform === 'linux') {
    return <svg viewBox="0 0 24 24" role="img" aria-label="Linux"><path d="M12 2c-3.1 0-5 2.8-5 6.8 0 1.4-.5 2.8-1.4 4.2-1.3 2-1.3 4.3-.2 5.8.8 1 2 1.1 3.3.4.9.6 2 1 3.3 1s2.4-.4 3.3-1c1.3.7 2.5.6 3.3-.4 1.2-1.5 1.1-3.8-.2-5.8-.9-1.4-1.4-2.8-1.4-4.2C17 4.8 15.1 2 12 2Zm-2 5.2c-.6 0-1-.6-1-1.3s.4-1.3 1-1.3 1 .6 1 1.3-.4 1.3-1 1.3Zm4 0c-.6 0-1-.6-1-1.3s.4-1.3 1-1.3 1 .6 1 1.3-.4 1.3-1 1.3Zm-2 4.2-2.2-1.6L12 8.6l2.2 1.2L12 11.4Z" /></svg>;
  }
  if (platform === 'cloud') {
    return <svg viewBox="0 0 24 24" role="img" aria-label="Cloud"><path d="M7 19h10a5 5 0 0 0 .8-9.9A6.5 6.5 0 0 0 5.4 7.7 5.7 5.7 0 0 0 7 19Z" fill="none" stroke="currentColor" strokeWidth="1.6" /></svg>;
  }
  return <svg viewBox="0 0 24 24" role="img" aria-label="Server"><path d="M4 4h16v6H4V4Zm0 10h16v6H4v-6Z" fill="none" stroke="currentColor" strokeWidth="1.5" /><path d="M7 7h.01M7 17h.01" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" /></svg>;
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
        {session.profile ? <span className="fleet-session-profile">{session.tool === 'claude-code' ? 'Claude' : 'Codex'} · {session.profile}</span> : null}
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
