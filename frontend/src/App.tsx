import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { SessionTabs, type TabStatus } from './components/SessionTabs';
import { SessionView } from './components/SessionView';
import { EmptyState } from './components/EmptyState';
import { NewSessionDialog } from './components/NewSessionDialog';
import { ResumeDialog } from './components/ResumeDialog';
import { MobileNav } from './components/MobileNav';
import { ConnectionStatus, fromTerminalStatus } from './components/ConnectionStatus';
import { GridView } from './components/GridView';
import { useSessions } from './store/sessions';
import { useServers } from './lib/servers';
import { SettingsMenu } from './components/SettingsMenu';
import { useIsMobile } from './hooks/useMediaQuery';
import { ParserIcon } from './components/ParserIcon';
import { readTabOrder, writeTabOrder, applyOrder, moveBefore } from './lib/tabOrder';
import { useTabLabel } from './lib/tabLabels';
import { notify } from './lib/tauriBridge';
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

// Layout mode: tabs (default) or grid (Mac-mini-monitor tile view).
// Persisted per-window in localStorage so each window remembers its
// last choice. Grid is best when N ≥ 2 and the window is wide.
type LayoutMode = 'tabs' | 'grid';
const LAYOUT_KEY = 'pretty-pty:layout-mode';
function readStoredLayout(): LayoutMode {
  try {
    const v = window.localStorage.getItem(LAYOUT_KEY);
    if (v === 'tabs' || v === 'grid') return v;
  } catch { /* ignore */ }
  return 'tabs';
}

export function App(): JSX.Element {
  const rawSessions = useSessions((s) => s.sessions);
  const activeId = useSessions((s) => s.activeId);
  const setActive = useSessions((s) => s.setActive);
  const refresh = useSessions((s) => s.refresh);
  const kill = useSessions((s) => s.kill);

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
  const isMobile = useIsMobile();
  const [textSize, setTextSize] = useState(readTextSize());
  // On phones the layout toggle is hidden and mode is forced to "tabs"
  // — Grid is too cramped to be useful on a 390px viewport, and the
  // active-session full-screen view is what users actually want when
  // they're on the move. The persisted localStorage choice still
  // applies on desktop.
  const [layoutMode, setLayoutMode] = useState<LayoutMode>(readStoredLayout);
  const effectiveLayout: LayoutMode = isMobile ? 'tabs' : layoutMode;
  useEffect(() => {
    try { window.localStorage.setItem(LAYOUT_KEY, layoutMode); } catch { /* ignore */ }
  }, [layoutMode]);

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
      const isWorking = s.id === activeId ? activeStatus.isWorking : s.working;
      next.set(s.id, isWorking);
      if (prev && prev.get(s.id) === true && isWorking === false) {
        const label = (s.cwd?.split('/').filter(Boolean).pop()) || s.cmd || s.id.slice(0, 8);
        void notify(`${label} — done`, 'Claude finished');
      }
    }
    prevWorkingRef.current = next;
  }, [sessions, activeId, activeStatus.isWorking]);

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

  return (
    <div className={`app-shell text-size-${textSize.toLowerCase()}`}>
      <header className="app-header">
        <div className="app-brand" aria-hidden>pretty-PTY</div>
        {/* Tabs stay in both single-session and grid mode — the
            header always has the logo on the left, so reclaiming the
            space had limited value. In grid mode the tab strip just
            acts as a quick "jump back to single view" affordance plus
            the same +/↺ buttons. */}
        <SessionTabs
          sessions={sessions}
          activeId={activeId}
          statusBySession={statusBySession}
          iconBySession={iconBySession}
          onSwitch={setActive}
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
              className={`layout-toggle-btn${layoutMode === 'grid' ? ' is-active' : ''}`}
              onClick={() => setLayoutMode('grid')}
              title="Tile every session"
            >
              grid
            </button>
          </div>
        ) : null}
        <ConnectionStatus
          status={activeId ? fromTerminalStatus(activeStatus.terminalStatus) : null}
        />
        <SettingsMenu
          textSize={textSize}
          onTextSizeChange={setTextSize}
          onNewSession={() => setDialogOpen("new")}
        />
      </header>

      <main className="app-main">
        {effectiveLayout === 'grid' ? (
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
          ) : (
            <EmptyState onNew={() => setDialogOpen("new")} />
          )
        ) : sessions.length === 0 ? (
          <EmptyState onNew={() => setDialogOpen("new")} />
        ) : (
          // Mount one SessionView per session and toggle visibility with
          // CSS. The previous shape (single keyed instance) made every
          // tab switch a full unmount/remount: xterm rebuild, fresh WS,
          // full claudeEvents replay, full message-list re-render. For
          // long sessions that was 3+ seconds. Keeping all views mounted
          // means switching is just `display: flex` ↔ `display: none` —
          // instant. Trade: N concurrent WS + N parsers running. Fine
          // for typical use (<20 sessions).
          sessions.map((s) => (
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
        isWorking={activeStatus.isWorking}
        onSwitch={setActive}
        onNew={() => setDialogOpen("new")}
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
    // Replace $HOME with ~ for compactness.
    const home = '/Users/uzair';  // matches the user; harmless for others — just doesn't shorten
    return c.startsWith(home) ? '~' + c.slice(home.length) : c;
  }, [session?.cwd]);

  // Keep the OS window title (and tab title) in sync with the session
  // and its live status. The working glyph in the title is a useful
  // peripheral signal when the window is in the background.
  useEffect(() => {
    const workingMark = status.isWorking ? '✻ ' : '';
    document.title = `${workingMark}${label} — pretty-PTY`;
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
