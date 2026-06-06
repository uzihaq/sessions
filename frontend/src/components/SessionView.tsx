import { useCallback, useEffect, useRef, useState } from 'react';
import { useTerminal } from '../hooks/useTerminal';
import { useSessionSidebar } from '../hooks/useSessionSidebar';
import { RemoteView } from './RemoteView';
import { ScrollToBottomButton } from './ScrollToBottomButton';
import { useSessions } from '../store/sessions';
import { ParserIcon } from './ParserIcon';
import { snapshot as fetchServerSnapshot } from '../api/prettyd';
import { detectMultiChoice } from '../lib/detectMultiChoice';

import type { ActiveStatus } from '../App';

interface Props {
  sessionId: string;
  onStatusChange?: (s: ActiveStatus) => void;
  // True when this is the currently-focused session tab. Used to gate
  // expensive per-session work (snapshot polling for picker detection)
  // so we don't burn N×CPU for sessions the user isn't looking at.
  isActive?: boolean;
}

// View modes:
//   • terminal — raw xterm, sized to whatever screen we're viewing on.
//     For TUI work (slash-command pickers, vim, raw shell output).
//   • remote   — chat-app abstraction. Sources its message log from
//     Claude's persisted JSONL event stream. Stable UUIDs, structured
//     content, no TUI parsing. Default for Claude Code sessions.
//
// The old `pretty`, `split`, and `reflowed` modes were retired: Remote
// supersedes them for chat reading, and a viewport-sized Terminal view
// covers everything else without the parser pipeline.
type ViewMode = 'terminal' | 'remote';

const VIEW_KEY = 'pretty-pty:viewMode';

function readStoredView(): ViewMode {
  try {
    const v = window.localStorage.getItem(VIEW_KEY);
    if (v === 'terminal' || v === 'remote') return v;
    // Migrate retired modes — they all map to remote, which is the
    // default chat view that replaced them.
    if (v === 'reflowed' || v === 'pretty' || v === 'split') return 'remote';
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
// Pretty layout. The terminal stream stays the source of truth — its
// xterm instance stays mounted across mode toggles so the raw terminal
// is always one click away.
export function SessionView({ sessionId, onStatusChange, isActive = false }: Props): JSX.Element {
  const [viewMode, setViewMode] = useState<ViewMode>(readStoredView);

  // Sticky "have we ever needed xterm for this session?" Once true,
  // stays true so toggling Pretty↔Terminal doesn't tear down xterm.
  // Starts true if Terminal is the persisted view; otherwise false
  // until the user clicks Terminal. With keep-mounted SessionViews
  // and ~8 sessions open, this saves ~2MB of memory + N×xterm DOM
  // trees when the user lives in Pretty view.
  const [hasMountedTerminal, setHasMountedTerminal] = useState(viewMode === 'terminal');
  useEffect(() => {
    if (viewMode === 'terminal' && !hasMountedTerminal) setHasMountedTerminal(true);
  }, [viewMode, hasMountedTerminal]);

  const term = useTerminal(sessionId, hasMountedTerminal);
  const session = useSessions((s) => s.sessions.find((x) => x.id === sessionId)) ?? null;
  const sidebar = useSessionSidebar({
    session,
    claudeEvents: term.claudeEvents,
    daemonWorking: session?.working ?? false
  });

  useEffect(() => {
    writeStoredView(viewMode);
  }, [viewMode]);

  const sendInput = useCallback((data: string) => {
    term.sendInputRef.current(data);
  }, [term.sendInputRef]);

  const scrollTerminalToBottom = useCallback((): void => {
    term.scrollTerminalToBottomRef.current();
  }, [term.scrollTerminalToBottomRef]);

  // Auto-switch to Terminal when Claude's TUI shows a numbered-choice
  // picker. The picker needs arrow-keys + Enter to interact, which the
  // chat input can't deliver — typing a number lands as a normal user
  // message instead of selecting the option. Polls the server snapshot
  // every 2s while this session is the active tab and we're in Pretty
  // view. Auto-switch fires once per picker (when it transitions from
  // absent → present); user can manually switch back to Pretty if they
  // want, and the next picker triggers a fresh switch.
  const lastPickerSeenRef = useRef(false);
  useEffect(() => {
    if (!isActive) return;
    if (viewMode !== 'remote') return;
    let alive = true;
    const tick = async (): Promise<void> => {
      try {
        const snap = await fetchServerSnapshot(sessionId);
        if (!alive) return;
        const present = !!(snap && detectMultiChoice(snap.text));
        if (present && !lastPickerSeenRef.current) {
          lastPickerSeenRef.current = true;
          setViewMode('terminal');
        } else if (!present) {
          lastPickerSeenRef.current = false;
        }
      } catch { /* transient — try again next tick */ }
    };
    void tick();
    const id = window.setInterval(() => { void tick(); }, 2000);
    return () => { alive = false; window.clearInterval(id); };
  }, [sessionId, isActive, viewMode]);

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
    <div className={`session-view view-${viewMode}`}>
      <div className="session-toolbar">
        <span className={`status-dot status-${term.status}`} />
        <span className="status-text">{term.status}</span>
        {term.resumedFromSeq !== null && term.resumedFromSeq > 0 ? (
          <span className="status-resumed">resumed from seq {term.resumedFromSeq}</span>
        ) : null}
        <span className="session-parser">
          <ParserIcon icon={sidebar.parserIcon} size={18} />
          <span>{sidebar.parserName}</span>
        </span>
        {term.exitInfo ? (
          <span className="status-exit">
            exited code={term.exitInfo.code ?? '∅'} signal={term.exitInfo.signal ?? '∅'}
          </span>
        ) : null}
        <div className="view-toggle" role="tablist" aria-label="view mode">
          <button
            type="button"
            className={`view-toggle-btn${viewMode === 'terminal' ? ' is-active' : ''}`}
            onClick={() => setViewMode('terminal')}
          >
            Terminal
          </button>
          <button
            type="button"
            className={`view-toggle-btn${viewMode === 'remote' ? ' is-active' : ''}`}
            onClick={() => setViewMode('remote')}
            title="Chat-style abstraction with its own message log"
          >
            Pretty
          </button>
        </div>
      </div>

      {/* xterm host stays in the DOM in both modes so the buffer + WS
          stay alive while the user is reading Remote view. CSS hides
          whichever pane the active view-mode doesn't want. */}
      <div className="session-body">
        <div className="session-terminal-pane">
          <div className="terminal-host" ref={term.containerRef} />
          <ScrollToBottomButton
            visible={!term.terminalAtBottom}
            onClick={scrollTerminalToBottom}
          />
        </div>
        <div className="session-remote-pane">
          <RemoteView
            sessionId={sessionId}
            claudeEvents={term.claudeEvents}
            send={sendInput}
            connected={term.status === 'open'}
            sidebar={sidebar}
            cwd={session?.cwd}
          />
        </div>
      </div>
    </div>
  );
}
