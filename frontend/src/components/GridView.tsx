import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ClipboardEvent } from 'react';
import type { SessionInfo } from '../types';
import type { TabStatus } from './SessionTabs';
import { fetchClaudeEvents, sendInput } from '../api/prettyd';
import { useServers } from '../lib/servers';
import { openSessionWindow } from '../lib/tauriBridge';
import { keyToBytes } from '../lib/keyToBytes';
import { ParserIcon } from './ParserIcon';
import { renderContent } from '../lib/contentRender';
import { eventsToMessages } from '../lib/claudeEvents';
import { copyOnClickAtPointer } from '../lib/copyText';
import { getTabLabel, useTabLabel } from '../lib/tabLabels';
import type { DispatchMessage } from '../hooks/useDispatch';

// Tile every session in a column-flow grid. Each cell renders a
// chat-style preview (the most recent user message + Claude reply
// bubbles) — same shape as Remote view, just compact. Click on the
// cell to focus it; keystrokes from the cell forward straight to the
// session's PTY so you can dispatch quick replies from any cell.

interface Props {
  sessions: SessionInfo[];
  statusBySession: Record<string, TabStatus>;
  iconBySession: Record<string, string>;
  // Kill the session (same as the tab × in tabs mode). Each grid cell
  // gets its own × button in the header — without it the user has no
  // way to close a session from grid view.
  onClose?: (id: string) => void | Promise<void>;
  // Reserved for future "expand" affordance (e.g. dbl-click cell). Grid
  // currently doesn't auto-switch to tabs view on cell click — the user
  // explicitly wants to monitor + type from grid without flipping modes.
  onExpand?: (id: string) => void;
}

// Note: this is the cwd-derived FALLBACK only. Each cell wraps it
// with the user's tab-label override via useTabLabel below — that's
// the value rendered in the cell header / typing popup / pop-out.
function derivedLabel(s: SessionInfo): string {
  // Same resolution order as SessionTabs: Claude's own title (custom
  // first, then ai-summary) > cwd basename > cmd > short id. User's
  // pretty-PTY rename is layered ABOVE this in the cell render path.
  if (s.claudeCustomTitle && s.claudeCustomTitle.length > 0) return s.claudeCustomTitle;
  if (s.claudeAiTitle && s.claudeAiTitle.length > 0) return s.claudeAiTitle;
  if (s.cwd) {
    const parts = s.cwd.split('/').filter(Boolean);
    const last = parts[parts.length - 1];
    if (last) return last;
  }
  return s.cmd.split('/').pop() ?? s.id.slice(0, 8);
}

// "5s", "3m", "2h ago" — short relative-time label for the cell header
// so the user can see at a glance how stale a session's last activity
// is. Anything older than a day rolls up to "Xd".
function relativeTime(ts: number): string {
  const diff = Math.max(0, Date.now() - ts);
  if (diff < 60_000) return `${Math.floor(diff / 1000)}s`;
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h`;
  return `${Math.floor(diff / 86_400_000)}d`;
}

// Auto-fit column layout: cells flow into 320-px minimum columns. On a
// phone you get 1 column; on a 1080-px laptop you get 3; on a 4k
// monitor you get more. No more fixed N×M; cells flow into whatever
// columns fit the viewport.
export function GridView({ sessions, statusBySession, iconBySession, onClose, onExpand }: Props): JSX.Element {
  return (
    <div className="grid-view">
      {sessions.map((s) => {
        const label = getTabLabel(s.id) ?? derivedLabel(s);
        return (
          <GridCell
            key={s.id}
            session={s}
            status={statusBySession[s.id] ?? 'idle'}
            icon={iconBySession[s.id] ?? '⬛'}
            onPopOut={() => openSessionWindow(s.id, label)}
            onExpand={onExpand ? () => onExpand(s.id) : undefined}
            onClose={onClose ? () => onClose(s.id) : undefined}
          />
        );
      })}
    </div>
  );
}

interface CellProps {
  session: SessionInfo;
  status: TabStatus;
  icon: string;
  onPopOut: () => void;
  onExpand?: () => void;
  onClose?: () => void | Promise<void>;
}

function GridCell({ session, status, icon, onPopOut, onExpand, onClose }: CellProps): JSX.Element {
  const [messages, setMessages] = useState<DispatchMessage[]>([]);
  const [focused, setFocused] = useState(false);
  // Tick the clock every 30s so the relative-time label in the header
  // ("3m ago") stays current without forcing a refetch.
  const [, setNow] = useState(Date.now());
  const cellRef = useRef<HTMLDivElement | null>(null);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  // Auto-stick to bottom only when the user is parked at the bottom.
  // Was unconditional → every 2s poll would yank scroll to bottom,
  // making it impossible to read older messages.
  const stickRef = useRef(true);
  const activeServerId = useServers((s) => s.activeId);

  // Refresh the cell's chat preview every 2s from Claude's JSONL
  // event log (cached server-side by the file watcher). Same data
  // source RemoteView consumes via WS — just polled here because
  // grid cells are glance-only and don't justify per-cell WS
  // connections. Event-derived messages drop every parsing hazard
  // that haunted the previous snapshot-scrape implementation
  // ("Wraysbury misparsed as Bash", picker items leaking, etc.).
  useEffect(() => {
    let alive = true;
    const tick = async (): Promise<void> => {
      try {
        // Only fetch the tail — a single cell shows max 10 messages
        // (~20 events on average since assistant turns split into
        // tool_use + reply events). Used to pull the full ~15-20 MB
        // ring buffer every 2s per cell, which was the #1 phone perf
        // sink. tail=40 covers any reasonable rendered window.
        const result = await fetchClaudeEvents(session.id, { tail: 40 });
        if (!alive || result === null) return;
        const msgs = eventsToMessages(result.events);
        setMessages(msgs.slice(-10));
      } catch { /* transient — try again next tick */ }
    };
    void tick();
    const id = window.setInterval(() => { void tick(); }, 2000);
    const tickNow = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => {
      alive = false;
      window.clearInterval(id);
      window.clearInterval(tickNow);
    };
  }, [session.id, activeServerId]);

  // Bottom-anchor when new messages land AND the user is at the
  // bottom. If they scrolled up to read history, leave them alone —
  // the 2s poll was previously yanking scroll back to bottom on every
  // tick, making it impossible to read older content.
  useEffect(() => {
    if (!stickRef.current) return;
    const el = bodyRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [messages]);

  const onBodyScroll = (): void => {
    const el = bodyRef.current;
    if (!el) return;
    stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
  };

  const cwd = useMemo(() => session.cwd ?? '', [session.cwd]);
  const customLabel = useTabLabel(session.id);
  const label = customLabel ?? derivedLabel(session);

  // Local typing buffer — shown as a floating popup over the cell while
  // focused so the user can see what they're typing without resizing
  // the cell. The actual bytes still get forwarded to the PTY on each
  // keystroke; this is purely visual feedback. Cleared on Enter (sent),
  // Escape (cancel), and on blur (focus left the cell).
  const [typedBuffer, setTypedBuffer] = useState('');

  // Direct keystroke forwarding. Each keystroke is translated to its
  // PTY byte sequence and POSTed via the input endpoint. The 2s
  // snapshot poll picks up the echo and re-renders the cell so the
  // user eventually sees their typing land in Claude's prompt — but
  // the typedBuffer popup gives instant feedback in the meantime.
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    const bytes = keyToBytes(e);
    if (bytes === null) return;
    e.preventDefault();
    void sendInput(session.id, bytes);

    // Maintain the local visual buffer alongside.
    const k = e.key;
    if (e.metaKey || e.ctrlKey || e.altKey) {
      // Modifier combos (Cmd-Backspace = kill, Ctrl-C = SIGINT, etc.)
      // usually move or clear the input box. Safest to clear here.
      setTypedBuffer('');
    } else if (k === 'Backspace') {
      setTypedBuffer((s) => s.slice(0, -1));
    } else if (k === 'Enter') {
      // Sent — clear the popup. Snapshot poll will surface the
      // message as a user_input bubble in the cell shortly.
      setTypedBuffer('');
    } else if (k === 'Escape') {
      setTypedBuffer('');
    } else if (k.length === 1) {
      setTypedBuffer((s) => s + k);
    } else {
      // Tab, arrows, F-keys etc. — cursor probably moved.
      setTypedBuffer('');
    }
  };

  // Paste handler — mirrors Claude Code's TUI convention. Sends the
  // bracketed-paste sequence to the PTY (so Claude treats it as a
  // single paste, not a keystroke storm) and updates the local
  // buffer with either the literal text or a "[Pasted +N lines]"
  // marker for multi-line content. Single-line short pastes appear
  // inline (the user pasted a URL); long or multi-line pastes get
  // the placeholder so the popup doesn't overflow the cell.
  const onPaste = (e: ClipboardEvent<HTMLDivElement>): void => {
    const text = e.clipboardData?.getData('text');
    if (!text) return;
    e.preventDefault();
    // Bracketed paste, no trailing Enter — user submits with Return
    // separately. Same protocol as InputBar's paste path.
    void sendInput(session.id, `\x1b[200~${text}\x1b[201~`);
    // Local-buffer display marker.
    const newlines = (text.match(/\n/g) ?? []).length;
    let marker: string;
    if (newlines > 0) {
      marker = `[Pasted text +${newlines + 1} lines]`;
    } else if (text.length > 80) {
      marker = `[Pasted text ${text.length} chars]`;
    } else {
      marker = text;
    }
    setTypedBuffer((s) => s + marker);
  };

  const focusCell = (): void => {
    cellRef.current?.focus();
  };

  // The typedBuffer used to clear on blur (when the user clicked away
  // from this cell). That dropped the user's draft — they came back
  // and saw nothing. Now we KEEP the buffer across blur so switching
  // between cells preserves each cell's in-progress text. The popup
  // hides while unfocused (it only renders when `focused`) but the
  // state lives. Cleared explicitly on Enter / Escape / modifier
  // combos via the onKeyDown handler.

  // Status text — "working · 5s", "idle · 3m". Working comes from the
  // active parser/sidebar (lifted up via statusBySession). Time ago is
  // computed off session.lastDataAt, ticked every 30s.
  const statusText = session.exited
    ? `exited${session.exitCode != null ? ` · ${session.exitCode}` : ''}`
    : status === 'working'
    ? `working · ${relativeTime(session.lastDataAt)}`
    : `idle · ${relativeTime(session.lastDataAt)}`;

  return (
    <div
      className={`grid-cell${focused ? ' is-focused' : ''}${status === 'working' && !session.exited ? ' is-working' : ''}${session.exited ? ' is-exited' : ''}`}
      ref={cellRef}
      tabIndex={0}
      onClick={focusCell}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      onKeyDown={onKeyDown}
      onPaste={onPaste}
    >
      <div className="grid-cell-head">
        <span className="grid-cell-icon" aria-hidden><ParserIcon icon={icon} size={18} /></span>
        <span className="grid-cell-name">{label}</span>
        <span className={`grid-cell-status${status === 'working' ? ' is-working' : ''}${session.exited ? ' is-exited' : ''}`}>
          {status === 'working' ? <span className="grid-cell-dot" aria-hidden /> : null}
          {statusText}
        </span>
        {onExpand ? (
          <button
            type="button"
            className="grid-cell-expand"
            onClick={(e) => { e.stopPropagation(); onExpand(); }}
            title="Expand to single-session view"
          >⤢</button>
        ) : null}
        <button
          type="button"
          className="grid-cell-popout"
          onClick={(e) => { e.stopPropagation(); onPopOut(); }}
          title="Pop out into its own window"
        >↗</button>
        {onClose ? (
          <button
            type="button"
            className="grid-cell-close"
            onClick={(e) => { e.stopPropagation(); void onClose(); }}
            title="Close this session (same as the tab × in tabs mode)"
            aria-label="Close session"
          >×</button>
        ) : null}
      </div>
      <div ref={bodyRef} className="grid-cell-body grid-cell-body-chat" onScroll={onBodyScroll}>
        {messages.length === 0 ? (
          <div className="grid-cell-empty">(no recent messages)</div>
        ) : (
          messages.map((m) => (
            <div
              key={m.id}
              className={`grid-cell-msg grid-cell-msg-${m.role}`}
            >
              {m.role === 'user' ? (
                <div
                  className="grid-cell-bubble grid-cell-bubble-user"
                  onClick={(e) => copyOnClickAtPointer(e, m.content)}
                >
                  {m.content}
                </div>
              ) : (
                <div
                  className="grid-cell-bubble grid-cell-bubble-assistant md-content"
                  onClick={(e) => copyOnClickAtPointer(e, m.content)}
                  dangerouslySetInnerHTML={{ __html: renderContent(m.content, cwd) }}
                />
              )}
            </div>
          ))
        )}
      </div>
      {/* Typing popup — floats over the cell while focused. Visible
          whenever the cell has focus (not just after the first
          keypress) so the user immediately sees "yes, my keystrokes
          will land here." The caret is rendered regardless; the
          typed text appears alongside as it accumulates. */}
      {focused ? (
        <div className="grid-cell-typing-popup" role="status" aria-live="polite">
          {typedBuffer ? (
            <span className="grid-cell-typing-text">{typedBuffer}</span>
          ) : (
            <span className="grid-cell-typing-placeholder">type to send to {label}</span>
          )}
          <span className="grid-cell-typing-caret" aria-hidden>▮</span>
        </div>
      ) : null}
      {/* Footer strip that doubles as focus indicator. When the cell
          isn't focused it reads "Click to type". When focused, a
          blinking caret glyph + "typing →" makes it obvious that
          keystrokes will land in this session. */}
      <div className="grid-cell-foot">
        {focused ? (
          <>
            <span className="grid-cell-caret" aria-hidden>▮</span>
            <span>typing → {label}</span>
          </>
        ) : (
          <span className="grid-cell-foot-hint">Click to type</span>
        )}
      </div>
    </div>
  );
}
