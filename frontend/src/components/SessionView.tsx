import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { useTerminal } from '../hooks/useTerminal';
import { useSessionSidebar } from '../hooks/useSessionSidebar';
import { RemoteView } from './RemoteView';
import { ScrollToBottomButton } from './ScrollToBottomButton';
import { useSessions } from '../store/sessions';
import { ParserIcon } from './ParserIcon';
import { wsMuxUrl } from '../api/sessionsd';
import { detectMultiChoice } from '../lib/detectMultiChoice';
import { requestSnapshot } from '../lib/wsMux';
import { SessionDetails } from './SessionDetails';
import { ProviderBadge, normalizeProvider } from './ProviderBadge';
import { getActiveServer } from '../lib/servers';
import { sessionLabel, useTabLabel } from '../lib/tabLabels';
import { SessionHistoryView } from './SessionHistoryView';

import type { ActiveStatus } from '../App';

interface Props {
  sessionId: string;
  onStatusChange?: (s: ActiveStatus) => void;
  // True when this is the currently-focused session tab. Used to gate
  // expensive per-session work (snapshot polling for picker detection)
  // so we don't burn N×CPU for sessions the user isn't looking at.
  isActive?: boolean;
  onDelegate?: (sessionId: string) => void;
  onResume?: (session: import('../types').SessionInfo) => void;
}

// View modes:
//   • terminal — raw xterm, sized to whatever screen we're viewing on.
//     For TUI work (slash-command pickers, vim, raw shell output).
//   • remote   — provider-neutral conversation GUI. Sources its message
//     log from Claude JSONL or Codex's normalized/app-server event stream.
//     Stable identities, structured activity, no TUI scraping.
//
// The old `sessions`, `split`, and `reflowed` modes were retired: Remote
// supersedes them for chat reading, and a viewport-sized Terminal view
// covers everything else without the parser pipeline.
type ViewMode = 'terminal' | 'remote' | 'details';

const VIEW_KEY = 'sessions:viewMode';

function readStoredView(): ViewMode {
  try {
    const v = window.localStorage.getItem(VIEW_KEY);
    if (v === 'terminal' || v === 'remote' || v === 'details') return v;
    // Migrate retired modes — they all map to remote, which is the
    // default chat view that replaced them.
    if (v === 'reflowed' || v === 'sessions' || v === 'split') return 'remote';
  } catch {
    // ignore
  }
  return 'remote';
}

function writeStoredView(mode: ViewMode): void {
  try {
    window.localStorage.setItem(VIEW_KEY, mode);
  } catch {
    // ignore
  }
}

// Owns useTerminal for the active session and exposes a Terminal /
// Sessions layout. The terminal stream stays the source of truth — its
// xterm instance stays mounted across mode toggles so the raw terminal
// is always one click away.
//
// memo()'d: all 36 SessionViews stay mounted, and App re-renders every 3s
// (session poll). Without memo, that parent re-render re-renders every
// child; with it (plus stable session refs from reconcileSessions), an
// unchanged session's view skips the poll entirely. Props are all stable
// per session (sessionId; onStatusChange is setActiveStatus for the active
// tab and undefined otherwise; isActive flips only on switch).
function SessionViewInner({ sessionId, onStatusChange, isActive = false, onDelegate }: Props): JSX.Element {
  const [viewMode, setViewMode] = useState<ViewMode>(readStoredView);
  const session = useSessions((s) => s.sessions.find((x) => x.id === sessionId)) ?? null;
  const allSessions = useSessions((s) => s.sessions);
  const endSession = useSessions((s) => s.kill);
  const customLabel = useTabLabel(sessionId, session?.cwd);

  // Claude and Codex both expose structured conversation history. Codex TUI
  // rollouts use the normalized event adapter; codex-app-server sessions add
  // live deltas, plans, commands, file diffs, reasoning summaries, and usage.
  // Raw shell sessions remain terminal-only.
  const supportsConversation = !session || session.tool === 'claude-code' || session.tool === 'codex';
  const effectiveView: ViewMode = supportsConversation
    ? viewMode
    : (viewMode === 'details' ? 'details' : 'terminal');
  const displayParentID = session?.displayParentSessionId !== undefined
    ? session.displayParentSessionId
    : session?.parentSessionId;
  const parent = displayParentID ? allSessions.find((item) => item.id === displayParentID) : null;
  const children = allSessions.filter((item) => (
    item.displayParentSessionId !== undefined ? item.displayParentSessionId : item.parentSessionId
  ) === sessionId);
  const failedSession = (session?.exited && (((session.exitCode ?? 0) !== 0) || Boolean(session.exitSignal)))
    || session?.idleReason === 'failed'
    || session?.provenanceStatus === 'lost'
    || session?.provenanceStatus === 'invalid';
  const runningChildren = children.filter((item) => item.working && !item.exited).length;
  const needsChildren = children.filter((item) =>
    !item.exited && !item.working
    && (item.idleReason ? item.idleReason === 'needs-input' : item.lastUserMessageAt !== null)
  ).length;
  const finishedChildren = children.filter((item) =>
    (item.exited && (item.exitCode ?? 0) === 0 && !item.exitSignal)
    || (!item.working && item.idleReason === 'completed')
  ).length;
  const failedChildren = children.filter((item) =>
    (item.exited && ((item.exitCode ?? 0) !== 0 || Boolean(item.exitSignal)))
    || item.idleReason === 'failed'
    || item.provenanceStatus === 'lost'
    || item.provenanceStatus === 'invalid'
  ).length;
  const provider = normalizeProvider(session?.tool);

  // Sticky "have we ever needed xterm for this session?" Once true,
  // stays true so toggling Sessions↔Terminal doesn't tear down xterm.
  // Starts true if Terminal is the persisted view; otherwise false
  // until the user clicks Terminal. With keep-mounted SessionViews
  // and ~8 sessions open, this saves ~2MB of memory + N×xterm DOM
  // trees when the user lives in Sessions view.
  const [hasMountedTerminal, setHasMountedTerminal] = useState(viewMode === 'terminal');
  // Brief toolbar notice shown when the auto-switch fires (picker
  // detected → Terminal). The draft in InputBar IS preserved because
  // RemoteView stays mounted (only CSS-hidden) — we tell the user
  // explicitly so they're not alarmed when they can't see the draft.
  const [pickerNotice, setPickerNotice] = useState(false);
  useEffect(() => {
    if (effectiveView === 'terminal' && !hasMountedTerminal) setHasMountedTerminal(true);
  }, [effectiveView, hasMountedTerminal]);

  const term = useTerminal(sessionId, hasMountedTerminal, isActive);
  const sidebar = useSessionSidebar({
    session,
    events: term.claudeEvents,
    daemonWorking: session?.working ?? false
  });
  const statusLabel = sidebar.isWorking
    ? 'Running'
    : failedSession
    ? 'Failed'
    : session?.idleReason === 'needs-input'
    ? 'Needs you'
    : session?.exited || session?.idleReason === 'completed'
    ? 'Finished'
    : session?.idleReason === 'never-started'
    ? 'Not started'
    : 'Idle';
  const statusTone = sidebar.isWorking
    ? ' is-running'
    : failedSession
    ? ' is-failed'
    : session?.idleReason === 'needs-input'
    ? ' is-needs-you'
    : session?.exited || session?.idleReason === 'completed'
    ? ' is-finished'
    : '';

  useEffect(() => {
    writeStoredView(viewMode);
  }, [viewMode]);

  const sendInput = useCallback((data: string) => {
    term.sendInputRef.current(data);
  }, [term.sendInputRef]);

  const scrollTerminalToBottom = useCallback((): void => {
    term.scrollTerminalToBottomRef.current();
  }, [term.scrollTerminalToBottomRef]);

  const focusTerminal = useCallback((): void => {
    term.focusTerminalRef.current();
  }, [term.focusTerminalRef]);

  const loadEarlierClaudeEvents = useCallback((): void => {
    term.loadEarlierClaudeEventsRef.current();
  }, [term.loadEarlierClaudeEventsRef]);

  // Put the cursor in the terminal when this tab becomes the active,
  // terminal-viewed session. Tab switches are a CSS display toggle (no
  // socket reconnect → no 'open'-status focus), so without this you'd
  // land on a visible terminal that isn't focused and have to hunt for
  // the right pixel to click. rAF waits for the pane to be display:flex
  // (it was display:none a frame ago) so focus() actually takes.
  useEffect(() => {
    if (!isActive || effectiveView !== 'terminal' || !hasMountedTerminal) return;
    const id = requestAnimationFrame(() => focusTerminal());
    return () => cancelAnimationFrame(id);
  }, [isActive, effectiveView, hasMountedTerminal, focusTerminal]);

  // Auto-switch to Terminal when Claude's TUI shows a numbered-choice
  // picker. The picker needs arrow-keys + Enter to interact, which the
  // chat input can't deliver — typing a number lands as a normal user
  // message instead of selecting the option. Polls the server snapshot
  // every 2s while this session is the active tab and we're in Sessions
  // view. Auto-switch fires once per picker (when it transitions from
  // absent → present); user can manually switch back to Sessions if they
  // want, and the next picker triggers a fresh switch.
  const lastPickerSeenRef = useRef(false);
  useEffect(() => {
    if (!isActive || session?.tool !== 'claude-code') return;
    if (effectiveView !== 'remote') return;
    let alive = true;
    const tick = async (): Promise<void> => {
      try {
        const snap = await requestSnapshot(wsMuxUrl(), sessionId);
        if (!alive) return;
        const present = !!(snap && detectMultiChoice(snap.text));
        if (present && !lastPickerSeenRef.current) {
          lastPickerSeenRef.current = true;
          setViewMode('terminal');
          // Tell the user their InputBar draft is safe — RemoteView is
          // CSS-hidden, not unmounted, so state is preserved. Without
          // this notice the user sees the Terminal pane appear with no
          // explanation and may think their draft was lost.
          setPickerNotice(true);
        } else if (!present) {
          lastPickerSeenRef.current = false;
        }
      } catch { /* transient — try again next tick */ }
    };
    void tick();
    const id = window.setInterval(() => { void tick(); }, 2000);
    return () => { alive = false; window.clearInterval(id); };
  }, [sessionId, session?.tool, isActive, effectiveView]);

  // Auto-clear the picker notice after 4s.
  useEffect(() => {
    if (!pickerNotice) return;
    const id = window.setTimeout(() => setPickerNotice(false), 4000);
    return () => window.clearTimeout(id);
  }, [pickerNotice]);

  // Push the active-session status up to App so the tab strip and mobile
  // nav reflect it.
  useEffect(() => {
    if (!onStatusChange) return;
    onStatusChange({
      isWorking: sidebar.isWorking,
      parserIcon: sidebar.parserIcon,
      parserName: sidebar.parserName,
      terminalStatus: term.status
    });
  }, [
    onStatusChange,
    sidebar.isWorking,
    sidebar.parserIcon,
    sidebar.parserName,
    term.status
  ]);

  return (
    <div className={`session-view view-${effectiveView}`}>
      <header className="session-active-header">
        <div className="session-active-copy">
          {parent ? <span className="session-parent-breadcrumb">{sessionLabel(parent)} <span>/</span> {session?.displayParentSessionId !== undefined ? 'grouped session' : 'child session'}</span> : <span className="session-parent-breadcrumb">Manager session</span>}
          <div className="session-active-title-row"><h1>{customLabel ?? (session ? sessionLabel(session) : 'Session')}</h1><span className={`session-live-pill${statusTone}`}>{statusLabel}</span></div>
          <div className="session-active-meta">
            {provider ? <ProviderBadge provider={provider} compact /> : <span className="provider-badge is-shell is-compact">⌘ Shell</span>}
            <span>{session?.profile || 'Default profile'}</span><span>{getActiveServer().name}</span><span title={session?.cwd}>{session?.cwd || 'Workspace unavailable'}</span>
          </div>
        </div>
        <div className="session-active-actions">
          {children.length > 0 ? <span className="child-health">{runningChildren} running · {needsChildren} needs you · {failedChildren} failed · {finishedChildren} finished</span> : null}
          {supportsConversation ? <button type="button" className="btn btn-ghost session-delegate" onClick={() => onDelegate?.(sessionId)}>↳ Delegate</button> : null}
        </div>
      </header>

      <div className="session-toolbar">
        <div className="view-toggle" role="tablist" aria-label="view mode">
          {supportsConversation ? (
            <button type="button" className={`view-toggle-btn${effectiveView === 'remote' ? ' is-active' : ''}`} onClick={() => setViewMode('remote')} title="Structured conversation, activity, plans, and usage">Conversation</button>
          ) : null}
          <button type="button" className={`view-toggle-btn${effectiveView === 'terminal' ? ' is-active' : ''}`} onClick={() => setViewMode('terminal')}>Terminal</button>
          {session ? <button type="button" className={`view-toggle-btn${effectiveView === 'details' ? ' is-active' : ''}`} onClick={() => setViewMode('details')}>Details</button> : null}
        </div>
        <span className={`status-dot status-${term.status}`} />
        <span className="status-text">{term.status}</span>
        {term.resumedFromSeq !== null && term.resumedFromSeq > 0 ? (
          <span className="status-resumed">resumed from seq {term.resumedFromSeq}</span>
        ) : null}
        <span className="session-parser">
          <ParserIcon icon={sidebar.parserIcon} size={18} />
          <span>{sidebar.parserName}</span>
        </span>
        {session?.kind === 'codex-app-server' ? (
          <span className="session-runtime-badge">app-server</span>
        ) : null}
        {session?.model ? (
          <span className="session-control-pill" title="Model fixed for this durable session">{session.model}</span>
        ) : null}
        {session?.effort ? (
          <span className="session-control-pill" title="Reasoning effort">{session.effort}</span>
        ) : null}
        {session?.fast ? (
          <span className="session-control-pill is-fast" title="Priority service tier">fast</span>
        ) : null}
        {term.exitInfo ? (
          <span className="status-exit">
            exited code={term.exitInfo.code ?? '∅'} signal={term.exitInfo.signal ?? '∅'}
          </span>
        ) : null}
        {pickerNotice ? (
          <span className="status-picker-notice" aria-live="polite">
            Switched to Terminal for picker — your draft is preserved in Sessions view
          </span>
        ) : null}
      </div>

      {/* xterm host stays in the DOM in both modes so the buffer + WS
          stay alive while the user is reading Remote view. CSS hides
          whichever pane the active view-mode doesn't want. */}
      <div className="session-body">
        <div className="session-terminal-pane" onPointerDown={focusTerminal}>
          <div className="terminal-host" ref={term.containerRef} />
          <div className="mobile-terminal-keys" role="toolbar" aria-label="Terminal keys">
            <button type="button" onClick={() => sendInput('\x1b')}>Esc</button>
            <button type="button" onClick={() => sendInput('\x1b[A')}>↑ Prev</button>
            <button type="button" onClick={() => sendInput('\x1b[B')}>↓ Next</button>
            <button type="button" onClick={() => sendInput('\x03')}>Ctrl-C</button>
          </div>
          <ScrollToBottomButton
            visible={!term.terminalAtBottom}
            onClick={scrollTerminalToBottom}
          />
        </div>
        <div className="session-remote-pane">
          <RemoteView
            sessionId={sessionId}
            events={term.claudeEvents}
            send={sendInput}
            connected={term.status === 'open'}
            hasEarlierClaudeEvents={term.hasEarlierClaudeEvents}
            loadingEarlierClaudeEvents={term.loadingEarlierClaudeEvents}
            onLoadEarlierClaudeEvents={loadEarlierClaudeEvents}
            sidebar={sidebar}
            cwd={session?.cwd}
            onOpenTerminal={() => setViewMode('terminal')}
            provider={session?.tool ?? 'claude-code'}
          />
        </div>
        <div className="session-details-pane">
          {session ? <SessionDetails session={session} allSessions={allSessions} onEnd={endSession} /> : null}
        </div>
      </div>
    </div>
  );
}

function SessionViewRouter(props: Props): JSX.Element {
  const session = useSessions((state) => state.sessions.find((item) => item.id === props.sessionId)) ?? null;
  useEffect(() => {
    if (!session?.exited || !props.onStatusChange) return;
    props.onStatusChange({
      isWorking: false,
      parserIcon: session.tool === 'claude-code' ? '🟠' : session.tool === 'codex' ? '🟢' : '⬛',
      parserName: session.tool === 'claude-code' ? 'Claude' : session.tool === 'codex' ? 'Codex' : 'Terminal',
      terminalStatus: 'closed'
    });
  }, [props.onStatusChange, session?.exited, session?.tool]);
  if (session?.exited) return <SessionHistoryView session={session} onDelegate={props.onDelegate} onResume={props.onResume} />;
  return <SessionViewInner {...props} />;
}

export const SessionView = memo(SessionViewRouter);
