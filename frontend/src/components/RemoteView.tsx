import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useDispatch } from '../hooks/useDispatch';
import { renderContent } from '../lib/contentRender';
import { copyOnClickAtPointer } from '../lib/copyText';
import type { SessionSidebarState } from '../hooks/useSessionSidebar';
import type { ClaudeSessionEvent } from '../types';
import { InputBar } from './InputBar';
import { ScrollToBottomButton } from './ScrollToBottomButton';
import StatusSidebar from './StatusSidebar';
import { saveScrollPosition, readScrollPosition } from '../lib/scrollMemory';
import { eventsToMessages } from '../lib/claudeEvents';
import type { DispatchMessage } from '../hooks/useDispatch';

interface Props {
  sessionId: string;
  // Structured session events sourced from Claude's persisted JSONL.
  // Authoritative chat log — stable UUIDs, structured content. Empty
  // for non-Claude sessions or briefly during initial mount before
  // the watcher attaches.
  claudeEvents: ClaudeSessionEvent[];
  // Live byte sender — used by InputBar to dispatch the actual
  // keystrokes through the WS, and by retry() in useDispatch.
  send: (data: string) => void;
  connected: boolean;
  // Working / progress state computed from JSONL events (and the
  // daemon's byte-rate flag). Drives the activity strip + sidebar.
  sidebar: SessionSidebarState;
  // Session cwd for vscode://file/... linkification inside Claude's
  // markdown responses.
  cwd?: string;
}

// Remote view — a chat-app abstraction OVER the terminal. Owns its own
// message log (per-session, persisted to localStorage), reconciles
// against parser.blocks to detect send-confirmed and append assistant
// turns. The terminal is just an observable; once a message is in our
// log it never moves, never re-renders from somewhere else, and never
// causes the layout to bounce.
//
// Update cadence is intentionally relaxed — the user explicitly said
// it doesn't need to be live as long as it's accurate. The sidebar
// is fed by useSessionSidebar (JSONL-derived) and the visible working
// state is gated on terminal stop_reasons rather than a guessed verb
// cycle.

export function RemoteView({ sessionId, claudeEvents, send, connected, sidebar, cwd }: Props): JSX.Element {
  // Event-derived user contents — passed to useDispatch so pendings get
  // flipped to 'sent' when JSONL confirms them (instead of timing out
  // as 'failed'). Computed once per claudeEvents change; the Set is
  // stable across renders when its contents don't change so useDispatch's
  // effect doesn't re-run unnecessarily.
  const eventMessages = useMemo(() => eventsToMessages(claudeEvents), [claudeEvents]);
  // Occurrence COUNT per trimmed user content in the JSONL — a count, not
  // a set, so useDispatch can tell a genuinely-new re-send ("continue"
  // again) from a historical duplicate and not false-confirm it.
  const eventUserContentCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const m of eventMessages) {
      if (m.role !== 'user') continue;
      const c = m.content.trim();
      counts.set(c, (counts.get(c) ?? 0) + 1);
    }
    return counts;
  }, [eventMessages]);

  const { messages: dispatchMessages, recordSent, retry, remove, resetLog } = useDispatch({
    sessionId,
    eventUserContentCounts,
    send
  });

  // JSONL events are the authoritative chat record. Merge in only the
  // dispatch log's still-unconfirmed (pending/failed) user entries — sends
  // that haven't shown up in the JSONL yet. useDispatch flips an entry to
  // 'sent' (dropping it from this merge) as soon as a matching JSONL
  // occurrence appears; it's count-aware, so a re-send of text that's
  // already in history stays visibly pending until ITS bytes actually land
  // (the old content-set filter hid it immediately — making a dropped
  // re-send look delivered).
  const messages = useMemo<DispatchMessage[]>(() => {
    if (eventMessages.length === 0) return dispatchMessages;
    const stillPending = dispatchMessages.filter(
      (m) => m.role === 'user' && (m.status === 'pending' || m.status === 'failed')
    );
    return [...eventMessages, ...stillPending];
  }, [eventMessages, dispatchMessages]);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const initialPos = useMemo(
    () => readScrollPosition(sessionId, 'remote'),
    [sessionId]
  );
  const stickRef = useRef(initialPos ? initialPos.atBottom : true);
  const [atBottom, setAtBottom] = useState(initialPos ? initialPos.atBottom : true);

  // Tail window. Long sessions (adapted-co + others with hundreds of
  // turns) used to render every message on first paint, which made a
  // tab switch take 3+ seconds while markdown + code highlighting
  // chewed through the whole history. Now: only the last
  // TAIL_WINDOW_INITIAL bubbles are rendered; older ones unmount and
  // weigh nothing. When the user scrolls near the top we prepend
  // TAIL_WINDOW_STEP more, preserving their scroll anchor so they
  // don't get yanked. New messages always slide in at the bottom and
  // are inside the window by definition. Reset to the initial window
  // on session-tab switch so tab switches stay fast.
  const TAIL_WINDOW_INITIAL = 50;
  const TAIL_WINDOW_STEP = 50;
  const TAIL_EXPAND_TRIGGER_PX = 200;
  const [visibleCount, setVisibleCount] = useState(TAIL_WINDOW_INITIAL);
  useEffect(() => {
    setVisibleCount(TAIL_WINDOW_INITIAL);
  }, [sessionId]);

  const visibleMessages = useMemo(() => {
    if (messages.length <= visibleCount) return messages;
    return messages.slice(messages.length - visibleCount);
  }, [messages, visibleCount]);
  const hiddenCount = messages.length - visibleMessages.length;

  // Scroll-anchor preservation across window expansion. Prepending
  // older messages grows scrollHeight by ~the prepended block's
  // height; we add that delta to scrollTop so the visible content
  // doesn't jump. anchorRef is set BEFORE setVisibleCount fires, then
  // the layout effect below restores after React commits the larger
  // window.
  const anchorRef = useRef<{ scrollHeight: number; scrollTop: number } | null>(null);
  const expandWindow = useCallback((): void => {
    if (hiddenCount === 0) return;
    const el = scrollRef.current;
    if (!el) return;
    anchorRef.current = { scrollHeight: el.scrollHeight, scrollTop: el.scrollTop };
    setVisibleCount((n) => n + TAIL_WINDOW_STEP);
  }, [hiddenCount]);
  useLayoutEffect(() => {
    const anchor = anchorRef.current;
    if (!anchor) return;
    const el = scrollRef.current;
    if (!el) return;
    const delta = el.scrollHeight - anchor.scrollHeight;
    el.scrollTop = anchor.scrollTop + delta;
    anchorRef.current = null;
  }, [visibleCount]);

  // Auto-stick to bottom — but only if the user wasn't scrolling up to
  // read history. Depends on the full messages array, not just length,
  // because Claude streams content into existing assistant bubbles
  // (content grows, count doesn't). Without this, the scroll falls
  // behind whenever a long assistant reply expands. useLayoutEffect so
  // the scroll lands before paint and the user never sees a half-
  // scrolled frame.
  useLayoutEffect(() => {
    if (!stickRef.current) return;
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages]);

  // Restore saved scroll on session-tab switch (which remounts this
  // component). Runs before paint so the user never sees the top→pos
  // jump.
  useLayoutEffect(() => {
    if (!initialPos) return;
    const el = scrollRef.current;
    if (!el) return;
    if (initialPos.atBottom) el.scrollTop = el.scrollHeight;
    else el.scrollTop = initialPos.scrollTop;
  }, [initialPos]);

  const onScroll = (): void => {
    const el = scrollRef.current;
    if (!el) return;
    const isAtBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
    stickRef.current = isAtBottom;
    setAtBottom((prev) => (prev === isAtBottom ? prev : isAtBottom));
    saveScrollPosition(sessionId, 'remote', { scrollTop: el.scrollTop, atBottom: isAtBottom });
    // Tail-window expansion trigger: user is scrolling up to read
    // older history. Expand the window so the next chunk of older
    // messages renders. Anchor preservation keeps them visually in
    // place — no perceptible jump.
    if (el.scrollTop < TAIL_EXPAND_TRIGGER_PX && hiddenCount > 0 && anchorRef.current === null) {
      expandWindow();
    }
  };

  const scrollToBottom = useCallback((): void => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    stickRef.current = true;
    setAtBottom(true);
    saveScrollPosition(sessionId, 'remote', { scrollTop: el.scrollTop, atBottom: true });
  }, [sessionId]);

  // Two-step confirm for the destructive "clear log" action. window.confirm
  // is suppressed in Tauri/WebViews so we can't use it — instead we toggle
  // an inline confirm state that renders "Clear? [Clear] [Cancel]" in place
  // of the button. Pressing either option clears the confirm state.
  const [clearConfirm, setClearConfirm] = useState(false);
  const handleRefresh = (): void => setClearConfirm(true);
  const handleRefreshConfirm = (): void => { setClearConfirm(false); resetLog(); };
  const handleRefreshCancel = (): void => setClearConfirm(false);

  return (
    <div className="remote-view">
      {/* Refresh — wipes Remote's owned log and re-bootstraps from the
          parser's current blocks. Recovery valve for when Remote and
          Terminal disagree (accumulated dispatch artifacts). Tucked
          top-right; not pretty, but discoverable. Uses an inline
          two-step confirm so window.confirm isn't needed (it's
          suppressed in Tauri/WebViews). */}
      {clearConfirm ? (
        <div className="remote-refresh-confirm">
          <span className="remote-refresh-confirm-label">Clear log?</span>
          <button
            type="button"
            className="remote-refresh-confirm-yes"
            onClick={handleRefreshConfirm}
          >
            Clear
          </button>
          <button
            type="button"
            className="remote-refresh-confirm-no"
            onClick={handleRefreshCancel}
          >
            Cancel
          </button>
        </div>
      ) : (
        <button
          type="button"
          className="remote-refresh"
          onClick={handleRefresh}
          title="Clear local chat log and re-derive from terminal scrollback"
        >
          refresh
        </button>
      )}
      <div
        className="remote-scroll"
        ref={scrollRef}
        onScroll={onScroll}
      >
        {messages.length === 0 ? (
          <div className="remote-empty">
            <img
              src="/claude.png"
              alt=""
              aria-hidden
              className="remote-empty-watermark"
              draggable={false}
            />
            <p>No messages yet.</p>
            <p className="remote-empty-hint">
              Type below to dispatch your first message to Claude.
            </p>
          </div>
        ) : null}
        {hiddenCount > 0 ? (
          <button
            type="button"
            className="remote-load-earlier"
            onClick={expandWindow}
            title={`${hiddenCount} older messages hidden — click or scroll up to load`}
          >
            ↑ Load {Math.min(hiddenCount, TAIL_WINDOW_STEP)} earlier {hiddenCount === 1 ? 'message' : 'messages'} ({hiddenCount} hidden)
          </button>
        ) : null}
        {visibleMessages.map((m, i) => (
          <RemoteMessage
            key={m.id}
            message={m}
            cwd={cwd}
            isLatest={i === visibleMessages.length - 1}
            onRetry={() => retry(m.id)}
            onDelete={() => remove(m.id)}
          />
        ))}
        {/* Sticky-anchor: pins the down-arrow to the right edge of the
            centered 820px message column (same pattern as Pretty). */}
        <div className="scroll-to-bottom-anchor" aria-hidden={atBottom}>
          <ScrollToBottomButton visible={!atBottom} onClick={scrollToBottom} />
        </div>
      </div>

      <StatusSidebar
        parserName={sidebar.parserName}
        parserIcon={sidebar.parserIcon}
        isWorking={sidebar.isWorking}
        timer={sidebar.timer}
        tokens={sidebar.tokens}
        finalElapsed={sidebar.finalElapsed}
        currentTask={sidebar.currentTask}
        checklist={sidebar.checklist}
      />

      <div className="remote-input-wrap">
        <InputBar
          send={send}
          connected={connected}
          sessionId={sessionId}
          onSubmitted={recordSent}
        />
      </div>
    </div>
  );
}

interface RemoteMessageProps {
  message: ReturnType<typeof useDispatch>['messages'][number];
  cwd?: string;
  isLatest: boolean;
  onRetry: () => void;
  onDelete: () => void;
}

// Per-message render. Memoized — adapted-co + somewhere-tech both have
// hundreds of bubbles. Without memo, the entire list re-runs through
// markdown + ANSI + linkify on every messages-array reference change
// (which is every claudeEvent batch flush). With memo, only the bubble
// whose props actually changed renders.
//
// The onRetry/onDelete callbacks are pre-bound at the parent, so they
// reference identity changes on every parent render. We don't memoize
// them because the per-message overhead of useCallback would be a wash;
// instead the memo compare below ignores them — they're invoked, never
// compared.
function RemoteMessageInner({
  message: m,
  cwd,
  isLatest,
  onRetry,
  onDelete
}: RemoteMessageProps): JSX.Element {
  const isUser = m.role === 'user';
  const cls = `remote-msg remote-msg-${m.role} is-${m.status}${isLatest ? ' is-latest' : ''}${m.interrupted ? ' is-interrupted' : ''}${m.queued ? ' is-queued' : ''}`;

  // CSS-level height ratchet for the latest bubble: the parser sometimes
  // reports a shorter snapshot mid-stream (1 line) before re-emitting
  // the full set (5 lines), causing the chat to bounce up and down.
  // We measure the rendered bubble height on every render and remember
  // the max — applied as `min-height` so the box never visibly shrinks
  // while this is still the latest message. When a new message arrives
  // (`isLatest` flips false), the lock releases and the bubble settles
  // to its actual content height (which by then has stabilized).
  const bubbleRef = useRef<HTMLDivElement | null>(null);
  const [minHeight, setMinHeight] = useState(0);
  useLayoutEffect(() => {
    if (!isLatest) {
      if (minHeight !== 0) setMinHeight(0);
      return;
    }
    const el = bubbleRef.current;
    if (!el) return;
    const h = el.offsetHeight;
    if (h > minHeight) setMinHeight(h);
  }, [isLatest, m.content, m.status, minHeight]);

  const lockStyle = isLatest && minHeight > 0 ? { minHeight: `${minHeight}px` } : undefined;

  return (
    <div className={cls}>
      {isUser ? (
        <div
          className="remote-bubble remote-bubble-user"
          ref={bubbleRef}
          style={lockStyle}
          onClick={(e) => copyOnClickAtPointer(e, m.content)}
        >
          {m.queued ? (
            <div className="remote-bubble-badge remote-bubble-badge-queued" aria-label="queued">
              <span aria-hidden>⏳</span>
              <span>queued — Claude is finishing the previous turn</span>
            </div>
          ) : null}
          {m.interrupted ? (
            <div className="remote-bubble-badge remote-bubble-badge-interrupted" aria-label="interrupted">
              <span aria-hidden>⎋</span>
              <span>you interrupted Claude</span>
            </div>
          ) : (
            <div className="remote-bubble-content">{m.content}</div>
          )}
          {/* API error captured by the parser as a ⎿ response to this
              user_input (rate limit, server overload, etc.). Shown
              under the bubble so the user knows their message
              technically landed but the server refused. */}
          {m.errorResponse ? (
            <div className="remote-bubble-error">
              <span className="remote-bubble-error-icon" aria-hidden>⚠</span>
              <span>{m.errorResponse}</span>
            </div>
          ) : null}
          {m.status === 'pending' ? (
            <div className="remote-bubble-status">
              <span className="remote-bubble-spinner" aria-hidden />
              <span>sending</span>
            </div>
          ) : null}
          {m.status === 'failed' ? (
            <div className="remote-bubble-status remote-bubble-failed">
              <span>not delivered</span>
              <button
                type="button"
                className="remote-bubble-retry"
                onClick={onRetry}
              >
                retry
              </button>
              <button
                type="button"
                className="remote-bubble-delete"
                onClick={onDelete}
                title="Remove this entry from your local log. If Claude actually received the message, it'll reappear as a delivered entry on the next refresh."
              >
                delete
              </button>
            </div>
          ) : null}
          {/* Always-available delete on user bubbles, surfaces on hover —
              lets the user clean up duplicate entries left over from
              past retry-bug deliveries or any other artifact. */}
          {m.status !== 'failed' ? (
            <button
              type="button"
              className="remote-bubble-quickdelete"
              onClick={onDelete}
              title="Remove this entry from your local log."
              aria-label="Delete message"
            >
              ×
            </button>
          ) : null}
        </div>
      ) : (
        <div
          className="remote-bubble remote-bubble-assistant"
          ref={bubbleRef}
          style={lockStyle}
          onClick={(e) => copyOnClickAtPointer(e, m.content)}
        >
          {m.hadThinking ? (
            <div className="remote-bubble-thinking" aria-label="reasoning">
              <span aria-hidden>💭</span>
              <span>reasoned before replying</span>
            </div>
          ) : null}
          {m.content ? (
            <div
              className="remote-bubble-content md-content"
              dangerouslySetInnerHTML={{ __html: renderContent(m.content, cwd) }}
            />
          ) : null}
          {m.toolCalls && m.toolCalls.length > 0 ? (
            <ToolCallsPanel calls={m.toolCalls} />
          ) : null}
        </div>
      )}
    </div>
  );
}

const RemoteMessage = memo(RemoteMessageInner, (a, b) => {
  // Custom equality: skip if everything visible is unchanged. Callbacks
  // are deliberately excluded from the compare — they change identity
  // on every parent render but always do the same thing.
  if (a.isLatest !== b.isLatest) return false;
  if (a.cwd !== b.cwd) return false;
  const ma = a.message;
  const mb = b.message;
  // Reference equality on the same message object is the common case
  // (memoized by id in the parent, since events flow append-only).
  if (ma === mb) return true;
  return (
    ma.id === mb.id &&
    ma.role === mb.role &&
    ma.content === mb.content &&
    ma.status === mb.status &&
    ma.errorResponse === mb.errorResponse &&
    ma.queued === mb.queued &&
    ma.interrupted === mb.interrupted &&
    ma.hadThinking === mb.hadThinking &&
    ma.toolCalls === mb.toolCalls
  );
});

// Tool-calls panel: shows a collapsed "Used N tools" header by
// default. Click to expand → list of every tool with input preview
// and a per-tool disclosure for the full output. Each chip is
// data-no-copy so clicking inside doesn't trigger the bubble's
// click-to-copy. Stops propagation so the bubble doesn't try to
// copy when the user is interacting with the panel.
function ToolCallsPanel({
  calls
}: {
  calls: import('../hooks/useDispatch').ToolCall[];
}): JSX.Element {
  const [expanded, setExpanded] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  return (
    <div
      className={`remote-bubble-tools${expanded ? ' is-expanded' : ''}`}
      data-no-copy
      onClick={(e) => e.stopPropagation()}
    >
      <button
        type="button"
        className="remote-bubble-tools-toggle"
        onClick={() => setExpanded((v) => !v)}
      >
        {expanded ? '▾' : '▸'} Used {calls.length} {calls.length === 1 ? 'tool' : 'tools'}
        {!expanded ? (
          <span className="remote-bubble-tools-summary">
            {' · '}
            {Array.from(new Set(calls.map((t) => t.name))).slice(0, 4).join(', ')}
            {new Set(calls.map((t) => t.name)).size > 4 ? '…' : ''}
          </span>
        ) : null}
      </button>
      {expanded ? (
        <div className="remote-bubble-tools-list">
          {calls.map((t) => {
            const isOpen = openId === t.id;
            const hasResult = !!t.resultFull;
            return (
              <div key={t.id} className={`remote-bubble-tool-row${isOpen ? ' is-open' : ''}`}>
                <button
                  type="button"
                  className="remote-bubble-tool"
                  onClick={() => setOpenId(isOpen ? null : t.id)}
                  title={hasResult ? 'Click to view output' : 'No captured output'}
                >
                  <span className="remote-bubble-tool-name">{t.name}</span>
                  {t.inputPreview ? (
                    <span className="remote-bubble-tool-input">{t.inputPreview}</span>
                  ) : null}
                  <span className="remote-bubble-tool-caret" aria-hidden>{isOpen ? '▾' : '▸'}</span>
                </button>
                {isOpen ? (
                  <div className="remote-bubble-tool-detail">
                    {t.inputFull && t.inputFull !== t.inputPreview ? (
                      <details className="remote-bubble-tool-section" open>
                        <summary>input</summary>
                        <pre>{t.inputFull}</pre>
                      </details>
                    ) : null}
                    {t.resultFull ? (
                      <details className="remote-bubble-tool-section" open>
                        <summary>output</summary>
                        <pre>{t.resultFull}</pre>
                      </details>
                    ) : (
                      <div className="remote-bubble-tool-empty">(no output captured)</div>
                    )}
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

