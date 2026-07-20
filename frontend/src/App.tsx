import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { SessionTabs, type TabStatus } from './components/SessionTabs';
import { SessionView } from './components/SessionView';
import { EmptyState } from './components/EmptyState';
import { NewSessionDialog } from './components/NewSessionDialog';
import { ResumeDialog } from './components/ResumeDialog';
import { MobileNav } from './components/MobileNav';
import { ConnectionStatus, fromTerminalStatus } from './components/ConnectionStatus';
import { GridView } from './components/GridView';
import { FleetView } from './components/FleetView';
import { UsageDashboard } from './components/UsageDashboard';
import { SearchView } from './components/SearchView';
import { useSessions } from './store/sessions';
import { useServers, getActiveServer } from './lib/servers';
import { SettingsMenu } from './components/SettingsMenu';
import { useIsMobile } from './hooks/useMediaQuery';
import { ParserIcon } from './components/ParserIcon';
import { ConnectScreen } from './components/ConnectScreen';
import { formatServerEndpoint } from './lib/serverEndpoint';
import { readTabOrder, writeTabOrder, applyOrder, moveBefore } from './lib/tabOrder';
import { useTabLabel } from './lib/tabLabels';
import { getNativeRuntimeStatus, isTauri, notify, syncTrayServers } from './lib/tauriBridge';
import { readTextSize } from './lib/textSize';
import type { SessionTool } from './types';

const TOOL_ICONS: Record<SessionTool, string> = {
  'claude-code': '🟠',
  'codex': '🟢',
  'terminal': '⬛'
};

// Status of the currently-attached session, lifted out of SessionView so
// the tab strip and mobile nav can reflect it. Only the *active* session
// has live data here — inactive tabs stay 'idle' until we add background
// polling (deferred from Phase 4).
export interface ActiveStatus {
  isWorking: boolean;
  parserIcon: string;
  parserName: string;
  terminalStatus: string; // 'open' | 'connecting' | 'reconnecting' | 'error' | 'closed'
}

const INITIAL_STATUS: ActiveStatus = {
  isWorking: false,
  parserIcon: '⬛',
  parserName: 'Terminal',
  terminalStatus: 'connecting'
};

// Pop-out mode: a second window opened by Tauri (or window.open in the
// browser) for a single session. URL signals it: `?session=<id>&mode=single`.
// We render a stripped shell — no tabs, no server selector, no mobile nav,
// no grid toggle — and let SessionView fill the whole window.
function readSingleModeParams(): { sessionId: string } | null {
  if (typeof window === 'undefined') return null;
  const params = new URLSearchParams(window.location.search);
  if (params.get('mode') !== 'single') return null;
  const sessionId = params.get('session');
  return sessionId ? { sessionId } : null;
}

// Layout mode: tabs (default), fleet (all configured machines), or grid
// (active-machine monitor tiles).
// Persisted per-window in localStorage so each window remembers its
// last choice. Grid is best when N ≥ 2 and the window is wide.
type LayoutMode = 'tabs' | 'fleet' | 'search' | 'usage' | 'grid';
const LAYOUT_KEY = 'pretty-pty:layout-mode';
function readStoredLayout(): LayoutMode {
  try {
    const v = window.localStorage.getItem(LAYOUT_KEY);
    if (v === 'tabs' || v === 'fleet' || v === 'search' || v === 'usage' || v === 'grid') return v;
  } catch { /* ignore */ }
  return 'tabs';
}

function isMessageObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export function App(): JSX.Element {
  const activeServerId = useServers((state) => state.activeId);
  const servers = useServers((state) => state.servers);
  useEffect(() => {
    void syncTrayServers(servers);
  }, [servers]);
  return activeServerId ? <ConnectedApp /> : <ConnectScreen />;
}

function ConnectedApp(): JSX.Element {
  const rawSessions = useSessions((s) => s.sessions);
  const activeId = useSessions((s) => s.activeId);
  const setActive = useSessions((s) => s.setActive);
  const refresh = useSessions((s) => s.refresh);
  const kill = useSessions((s) => s.kill);
  // Track whether the session list has ever successfully loaded. While
  // hydrated is false, any error means we can't reach the daemon.
  const sessionsError = useSessions((s) => s.error);
  const sessionsHydrated = useSessions((s) => s.hydrated);
  const [nativeRuntimeError, setNativeRuntimeError] = useState<string | null>(null);
  useEffect(() => {
    if (!isTauri() || !sessionsError || sessionsHydrated) {
      setNativeRuntimeError(null);
      return;
    }
    void getNativeRuntimeStatus()
      .then((status) => setNativeRuntimeError(status?.state === 'error' ? status.detail : null))
      .catch(() => setNativeRuntimeError(null));
  }, [sessionsError, sessionsHydrated]);

  // User-defined tab order. Persisted in localStorage so the order
  // survives reloads. Server's session list comes back in creation
  // order; we apply the user's preferences on top before passing
  // to SessionTabs / GridView.
  const [tabOrder, setTabOrder] = useState<string[]>(readTabOrder);
  const sessions = useMemo(() => applyOrder(rawSessions, tabOrder), [rawSessions, tabOrder]);
  const reorderTab = useCallback((fromId: string, toId: string): void => {
    setTabOrder((prev) => {
      const next = moveBefore(prev, rawSessions.map((s) => s.id), fromId, toId);
      writeTabOrder(next);
      return next;
    });
  }, [rawSessions]);

  const single = useMemo(() => readSingleModeParams(), []);
  // dialog state holds null (closed), 'new' (fresh-session mode), or
  // 'resume' (opens with the resume picker pre-expanded). Two-state
  // open lets the toolbar's separate + and ↺ buttons route to the
  // right initial view of the same dialog.
  const [dialogOpen, setDialogOpen] = useState<null | 'new' | 'resume'>(null);
  const [activeStatus, setActiveStatus] = useState<ActiveStatus>(INITIAL_STATUS);

  // Bound how many sessions are kept LIVE (mounted SessionView → xterm
  // buffer + claudeEvents history + WS attach). Without this, every session
  // the user ever viewed kept its full terminal scrollback and message
  // history resident forever (the view was sticky-mounted and never
  // discarded) — so a long-open tab with dozens of windows accumulated
  // hundreds of MB and degraded into multi-second freezes. We keep only the
  // active session plus the few most-recently-viewed live; the rest are
  // discarded (their SessionView unmounts, freeing xterm + events) but stay
  // in the tab strip (SessionTabs renders ALL sessions, driven by the HTTP
  // poll) and re-hydrate instantly from the server snapshot + event replay
  // when clicked. Nothing is hidden — only un-viewed history is dropped.
  const LIVE_SESSION_CAP = 3;
  const [liveIds, setLiveIds] = useState<string[]>(() => (activeId ? [activeId] : []));
  useEffect(() => {
    if (!activeId) return;
    setLiveIds((prev) => (prev[0] === activeId
      ? prev
      : [activeId, ...prev.filter((id) => id !== activeId)].slice(0, LIVE_SESSION_CAP)));
  }, [activeId]);
  useEffect(() => {
    // Drop ids for sessions that no longer exist (killed/exited).
    setLiveIds((prev) => {
      const alive = prev.filter((id) => rawSessions.some((s) => s.id === id));
      return alive.length === prev.length ? prev : alive;
    });
  }, [rawSessions]);

  const isMobile = useIsMobile();
  const [textSize, setTextSize] = useState(readTextSize());
  // Grid is too cramped for a compact viewport. Fleet, search, and usage are
  // useful on phones and narrow Mac windows, so the mobile nav keeps them.
  const [layoutMode, setLayoutMode] = useState<LayoutMode>(readStoredLayout);
  const effectiveLayout: LayoutMode = isMobile && layoutMode === 'grid' ? 'tabs' : layoutMode;
  useEffect(() => {
    try { window.localStorage.setItem(LAYOUT_KEY, layoutMode); } catch { /* ignore */ }
  }, [layoutMode]);

  const openFleetSession = useCallback((serverId: string, sessionId: string): void => {
    useServers.getState().setActive(serverId);
    setActive(sessionId);
    setLayoutMode('tabs');
  }, [setActive]);
  useEffect(() => {
    if (!('serviceWorker' in navigator)) return;
    const onMessage = (event: MessageEvent<unknown>): void => {
      const data = event.data;
      if (!isMessageObject(data)) return;
      if (data.type !== 'push-open-session' || typeof data.sessionId !== 'string') return;
      setActive(data.sessionId);
      setLayoutMode('tabs');
    };
    navigator.serviceWorker.addEventListener('message', onMessage);
    return () => navigator.serviceWorker.removeEventListener('message', onMessage);
  }, [setActive]);

  // (Previously: reset activeStatus to INITIAL_STATUS on tab switch so
  // a freshly-mounting SessionView wouldn't briefly show stale values.
  // Removed — with keep-mounted SessionViews, the new active session's
  // WS is already 'open' and its onStatusChange effect fires immediately
  // with the real values. The reset was actively wrong: React runs
  // child effects before parent effects, so the parent's setActiveStatus
  // (INITIAL_STATUS, 'connecting') was overwriting the child's correct
  // push of 'open'. That's why the toolbar's connection pill was stuck
  // saying 'Connecting…' even though the WS was live.)

  // Pull session list on mount, then refresh every 3s so inactive tabs
  // get their daemon-reported `working` flag updated. The active tab
  // is overwritten below from the live parser state — the daemon
  // signal is just for sessions we aren't currently attached to. Also
  // re-runs whenever the active server changes so switching servers
  // immediately repopulates the tab strip from the new prettyd.
  const activeServerId = useServers((s) => s.activeId);
  const tokenRequiredServerId = useServers((s) => s.tokenRequiredServerId);
  useEffect(() => {
    void refresh();
    const id = window.setInterval(() => { void refresh(); }, 3000);
    return () => window.clearInterval(id);
  }, [refresh, activeServerId]);

  // Build per-session status/icon maps. Inactive tabs use the daemon's
  // activity-derived `working` flag (computed from PTY byte rate) and
  // its `tool` field (classified from the cmd at session create) for
  // the icon. Active tab is overwritten by the live parser state from
  // SessionView — that's strictly more accurate than the cmd-based
  // classification because it reads the actual buffer, but it's only
  // available for the session we're currently attached to.
  const statusBySession: Record<string, TabStatus> = {};
  const iconBySession: Record<string, string> = {};
  for (const s of sessions) {
    statusBySession[s.id] = s.working ? 'working' : 'idle';
    iconBySession[s.id] = TOOL_ICONS[s.tool];
  }
  if (activeId) {
    statusBySession[activeId] = activeStatus.isWorking ? 'working' : 'idle';
    iconBySession[activeId] = activeStatus.parserIcon;
  }

  // Working → idle desktop notifications. Track last-seen working state
  // per session id; fire whenever a session flips from true to false.
  // Compares against the daemon-reported `working` flag for *every* tab,
  // not just the active one — so a Claude turn finishing on a different
  // tab still pings. Skip the very first refresh so a cold app boot
  // doesn't fire N notifications for sessions that were idle before.
  const prevWorkingRef = useRef<Map<string, boolean> | null>(null);
  useEffect(() => {
    const prev = prevWorkingRef.current;
    const next = new Map<string, boolean>();
    for (const s of sessions) {
      // Use the daemon's `working` flag for EVERY session, including the
      // active one. It's now the honest footer-derived signal, and using
      // it uniformly avoids a phantom "done": on a tab switch, activeStatus
      // still holds the PREVIOUS session's value for one commit (the child
      // pushes the new one a render later), which used to record the new
      // tab as working=true and then fire a spurious "done" when it
      // corrected.
      const isWorking = s.working;
      next.set(s.id, isWorking);
      if (prev && prev.get(s.id) === true && isWorking === false) {
        const label = (s.cwd?.split('/').filter(Boolean).pop()) || s.cmd || s.id.slice(0, 8);
        void notify(`${label} — done`, 'Claude finished');
      }
    }
    prevWorkingRef.current = next;
  }, [sessions]);

  // Single-session pop-out window: skip every chrome element except
  // SessionView itself. The session id comes from the URL.
  if (single) {
    return (
      <SinglePopOut
        sessionId={single.sessionId}
        sessions={sessions}
        textSize={textSize}
      />
    );
  }

  if (isTauri() && sessionsError && !sessionsHydrated) {
    return (
      <ConnectScreen
        localDaemonUnavailable
        detail={nativeRuntimeError ?? sessionsError}
        onRetry={() => void refresh()}
      />
    );
  }

  return (
    <div className={`app-shell text-size-${textSize.toLowerCase()}`}>
      <header className="app-header">
        <div className="app-brand" aria-hidden>Sessions</div>
        {/* Tabs stay in single-session, fleet, and grid modes — the
            header always has the logo on the left, so reclaiming the
            space had limited value. In grid mode the tab strip just
            acts as a quick "jump back to single view" affordance plus
            the same +/↺ buttons. */}
        <SessionTabs
          sessions={sessions}
          activeId={activeId}
          statusBySession={statusBySession}
          iconBySession={iconBySession}
          onSwitch={(id) => { setActive(id); setLayoutMode('tabs'); }}
          onAdd={() => setDialogOpen("new")}
          onResume={() => setDialogOpen("resume")}
          onClose={(id) => kill(id)}
          onReorder={reorderTab}
        />
        {/* Layout toggle is desktop-only — Grid is too cramped on
            phones to add value, and the bottom MobileNav already gives
            phone users a fast switcher. */}
        {!isMobile ? (
          <div className="layout-toggle" role="tablist" aria-label="layout">
            <button
              type="button"
              className={`layout-toggle-btn${layoutMode === 'tabs' ? ' is-active' : ''}`}
              onClick={() => setLayoutMode('tabs')}
              title="Single session"
            >
              tabs
            </button>
            <button
              type="button"
              className={`layout-toggle-btn${layoutMode === 'fleet' ? ' is-active' : ''}`}
              onClick={() => setLayoutMode('fleet')}
              title="See sessions across every configured machine"
            >
              fleet
            </button>
            <button
              type="button"
              className={`layout-toggle-btn${layoutMode === 'search' ? ' is-active' : ''}`}
              onClick={() => setLayoutMode('search')}
              title="Search conversations across the fleet"
            >
              search
            </button>
            <button
              type="button"
              className={`layout-toggle-btn${layoutMode === 'usage' ? ' is-active' : ''}`}
              onClick={() => setLayoutMode('usage')}
              title="Local token usage and cost"
            >
              usage
            </button>
            <button
              type="button"
              className={`layout-toggle-btn${layoutMode === 'grid' ? ' is-active' : ''}`}
              onClick={() => setLayoutMode('grid')}
              title="Tile every session"
            >
              grid
            </button>
          </div>
        ) : null}
        <ConnectionStatus
          status={effectiveLayout === 'tabs' && activeId
            ? fromTerminalStatus(activeStatus.terminalStatus)
            : null}
        />
        <SettingsMenu
          textSize={textSize}
          onTextSizeChange={setTextSize}
          onNewSession={() => setDialogOpen("new")}
        />
      </header>

      <main className="app-main">
        {tokenRequiredServerId === activeServerId ? (
          <DaemonBanner
            error="prettyd: authentication required (401)"
            onRetry={() => void refresh()}
          />
        ) : effectiveLayout === 'fleet' ? (
          <FleetView onOpenSession={openFleetSession} />
        ) : effectiveLayout === 'search' ? (
          <SearchView onOpenSession={openFleetSession} />
        ) : effectiveLayout === 'usage' ? (
          <UsageDashboard />
        ) : effectiveLayout === 'grid' ? (
          sessions.length > 0 ? (
            <GridView
              sessions={sessions}
              statusBySession={statusBySession}
              iconBySession={iconBySession}
              onClose={(id) => kill(id)}
              // Optional expand affordance — exposed via the ⤢ button
              // on each cell. Click on the cell body itself focuses the
              // input rather than switching to tabs view.
              onExpand={(id) => { setActive(id); setLayoutMode('tabs'); }}
            />
          ) : sessionsError && !sessionsHydrated ? (
            <DaemonBanner error={sessionsError} onRetry={() => void refresh()} />
          ) : (
            <EmptyState onNew={() => setDialogOpen("new")} />
          )
        ) : sessions.length === 0 ? (
          sessionsError && !sessionsHydrated ? (
            <DaemonBanner error={sessionsError} onRetry={() => void refresh()} />
          ) : (
            <EmptyState onNew={() => setDialogOpen("new")} />
          )
        ) : (
          // Mount a SessionView only for the LIVE set (active + a few
          // recently-viewed), not all N sessions — see LIVE_SESSION_CAP.
          // The active one is always included even if the LRU effect hasn't
          // caught up yet. Visibility within the live set is still a CSS
          // display toggle, so switching between recently-viewed tabs stays
          // instant; switching to a long-dormant one re-mounts and
          // snapshot-prefills (fast, not blank). Every session still appears
          // in the tab strip above regardless of live state.
          sessions
            .filter((s) => s.id === activeId || liveIds.includes(s.id))
            .map((s) => (
              <div
                key={s.id}
                className={`session-view-host${s.id === activeId ? '' : ' is-hidden'}`}
              >
                <SessionView
                  sessionId={s.id}
                  isActive={s.id === activeId}
                  onStatusChange={s.id === activeId ? setActiveStatus : undefined}
                />
              </div>
            ))
        )}
      </main>

      <MobileNav
        sessions={sessions}
        activeId={activeId}
        layoutMode={effectiveLayout === 'grid' ? 'tabs' : effectiveLayout}
        statusBySession={statusBySession}
        iconBySession={iconBySession}
        onSwitch={(id) => { setActive(id); setLayoutMode('tabs'); }}
        onLayoutChange={setLayoutMode}
        onNew={() => setDialogOpen("new")}
        onResume={() => setDialogOpen("resume")}
      />

      {dialogOpen === 'new' ? (
        <NewSessionDialog
          onClose={() => setDialogOpen(null)}
          onOpenResume={() => setDialogOpen('resume')}
        />
      ) : null}
      {dialogOpen === 'resume' ? (
        <ResumeDialog
          onClose={() => setDialogOpen(null)}
          onStartNew={() => setDialogOpen('new')}
        />
      ) : null}
    </div>
  );
}

// Daemon-unreachable banner — shown when the first session-list fetch
// fails and we have no live data (hydrated is false). Two variants:
//   • Auth (401): token input + save + retry.
//   • Network: shows host:port so the user knows which prettyd to check.
//
// Auth detection: stream E's api/prettyd.ts throws an AuthError for 401
// responses; the sessions store stores its message. We check for '401'
// in the string — stable regardless of the exact message wording.
// updateServer is added by stream E to lib/servers.ts; we call it via
// getState() with a runtime guard so this compiles without a type cast.
function DaemonBanner({
  error,
  onRetry
}: {
  error: string;
  onRetry: () => void;
}): JSX.Element {
  const isAuthError = /\b401\b/.test(error);
  const server = getActiveServer();
  const [tokenInput, setTokenInput] = useState('');

  const handleTokenSubmit = (): void => {
    const token = tokenInput.trim();
    if (!token) return;
    // Save the pasted token onto the active server config, then retry.
    useServers.getState().updateServer(server.id, { token });
    onRetry();
  };

  return (
    <div className="daemon-banner">
      {isAuthError ? (
        <>
          <p className="daemon-banner-title">Authentication required</p>
          <p className="daemon-banner-host">{formatServerEndpoint(server)}</p>
          <p className="daemon-banner-hint">Enter the daemon token to connect.</p>
          <div className="daemon-banner-token-row">
            <input
              type="password"
              className="daemon-banner-token-input"
              placeholder="Token"
              value={tokenInput}
              autoFocus
              onChange={(e) => setTokenInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') handleTokenSubmit(); }}
            />
            <button
              type="button"
              className="btn btn-primary daemon-banner-token-submit"
              disabled={!tokenInput.trim()}
              onClick={handleTokenSubmit}
            >
              Connect
            </button>
          </div>
        </>
      ) : (
        <>
          <p className="daemon-banner-title">Daemon unreachable</p>
          <p className="daemon-banner-host">{server.host}:{server.port}</p>
          <p className="daemon-banner-hint">
            prettyd is not responding. Check that it is running on{' '}
            <strong>{server.host}</strong> port <strong>{server.port}</strong>.
          </p>
          <button
            type="button"
            className="btn daemon-banner-retry"
            onClick={onRetry}
          >
            Retry
          </button>
        </>
      )}
    </div>
  );
}

// Pop-out window shell. Renders a minimal top bar showing WHICH session
// this window is attached to (cwd basename + parser icon + working
// indicator) so the user can tell windows apart at a glance. Also
// drives document.title — Tauri's native window title is initially
// set in Rust via .title(...), but the WebView replaces it with the
// HTML <title> on load; setting document.title here keeps the macOS
// title bar in sync with the session.
function SinglePopOut({
  sessionId,
  sessions,
  textSize
}: {
  sessionId: string;
  sessions: import('./types').SessionInfo[];
  textSize: import('./lib/textSize').TextSize;
}): JSX.Element {
  const session = sessions.find((s) => s.id === sessionId);
  const overrideLabel = useTabLabel(sessionId);
  // Display label — same resolution as SessionTabs:
  //   user pretty-PTY override > claude custom > claude ai-title > cwd > cmd > short id.
  const label = useMemo(() => {
    if (overrideLabel) return overrideLabel;
    if (!session) return 'session';
    if (session.claudeCustomTitle) return session.claudeCustomTitle;
    if (session.claudeAiTitle) return session.claudeAiTitle;
    if (session.cwd) {
      const parts = session.cwd.split('/').filter(Boolean);
      const last = parts[parts.length - 1];
      if (last) return last;
    }
    return session.cmd || session.id.slice(0, 6);
  }, [overrideLabel, session]);

  const [status, setStatus] = useState<ActiveStatus>(INITIAL_STATUS);
  const cwdShort = useMemo(() => {
    const c = session?.cwd ?? '';
    if (!c) return '';
    // Shorten the OS home dir to ~ for compactness, without hardcoding a
    // username — match the standard macOS (/Users/<user>) and Linux
    // (/home/<user>) home layouts so it works for any operator.
    return c.replace(/^\/(Users|home)\/[^/]+/, '~');
  }, [session?.cwd]);

  // Keep the OS window title (and tab title) in sync with the session
  // and its live status. The working glyph in the title is a useful
  // peripheral signal when the window is in the background.
  useEffect(() => {
    const workingMark = status.isWorking ? '✻ ' : '';
    document.title = `${workingMark}${label} — Sessions`;
  }, [label, status.isWorking]);

  return (
    <div className={`app-shell single-mode text-size-${textSize.toLowerCase()}`}>
      <header className="single-mode-header">
        <ParserIcon icon={status.parserIcon} size={18} />
        <span className="single-mode-label">{label}</span>
        {cwdShort ? <span className="single-mode-cwd">{cwdShort}</span> : null}
        <span className="single-mode-spacer" />
        {status.isWorking ? (
          <span className="single-mode-working" aria-label="working">✻ working</span>
        ) : (
          <span className="single-mode-idle" aria-label="idle">○ idle</span>
        )}
      </header>
      <SessionView
        key={sessionId}
        sessionId={sessionId}
        onStatusChange={setStatus}
      />
    </div>
  );
}
