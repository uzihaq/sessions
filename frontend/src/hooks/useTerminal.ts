import { useCallback, useEffect, useRef, useState } from 'react';
// xterm + its CSS are dynamically imported below — Vite splits them into
// a separate chunk so the initial bundle (Pretty / Remote / Reflowed —
// the views most users hit first) doesn't pay xterm's ~250KB parse cost.
// On a fresh Android install over cellular, this is the difference
// between "instant tap-to-content" and "wait for the terminal lib to
// download even though you didn't open Terminal view."
import { wsUrl, snapshot as fetchServerSnapshot } from '../api/prettyd';
import { useServers } from '../lib/servers';
import type { ServerMsg, ClaudeSessionEvent } from '../types';

type Status = 'connecting' | 'open' | 'reconnecting' | 'closed' | 'error';

interface UseTerminalResult {
  containerRef: (el: HTMLDivElement | null) => void;
  status: Status;
  exitInfo: { code: number | null; signal: string | null } | null;
  resumedFromSeq: number | null;
  // Send raw input (text or control bytes) through the live WS. Lets
  // InputBar share the same channel as the xterm itself — xterm echoes
  // the result back, so the terminal stays the source of truth.
  sendInputRef: { current: (data: string) => void };
  // Scroll position state for the floating "scroll to latest" button.
  // True when xterm's viewport is parked at the live tail; flips false
  // as soon as the user scrolls up. Driven by xterm's onScroll event.
  terminalAtBottom: boolean;
  // Imperative jump-to-bottom on xterm. Wired to the floating button.
  scrollTerminalToBottomRef: { current: () => void };
  // Stream of Claude Code's structured session events, captured from
  // the same WS we use for raw bytes. The server tails
  // ~/.claude/projects/<encoded-cwd>/<id>.jsonl and forwards each
  // typed event. RemoteView consumes this instead of the parser-
  // derived blocks — UUIDs are stable, content is structured, no
  // regex required. Empty for non-Claude sessions.
  claudeEvents: ClaudeSessionEvent[];
}

const RECONNECT_BACKOFF_MS = [500, 1000, 2000, 4000, 8000] as const;

// Cap the in-memory claudeEvents array. The server's ring caps at 5000;
// without a matching client cap a days-long tab kept open accumulates tens
// of MB (tool_results carry full command/file output) and RemoteView's
// eventsToMessages re-walks the whole array on every batch. Keep the most
// recent N — the client counter (claudeEventsSeen) stays absolute, so
// reconnect resume is unaffected.
const CLAUDE_EVENT_CAP = 5000;

// Phase 2: xterm.js mounted into a div, bound to a prettyd session over WS.
// Every output frame carries a seq#; we persist the latest in localStorage
// so a phone-lock-induced disconnect can resume from where we left off.
//
// On WS close that isn't a clean PTY exit, the hook reconnects with
// exponential backoff, passing lastSeq so the server replays only the
// chunks the terminal actually missed.
// `mountTerminal=true` enables full xterm rendering: dynamic import,
// term.open(container), FitAddon resize, snapshot prefill, the works.
// When `false`, the hook still opens the WS and ingests claudeEvents
// (so Remote view stays live) — but skips the ~250KB xterm instance,
// its DOM tree, and the FitAddon ResizeObserver. With keep-mounted
// SessionViews running N sessions at once, the savings stack up: a
// phone showing only Remote view doesn't allocate N xterms in the
// background. The flag should turn TRUE once the user has visited
// Terminal view at least once for a given session, and STAY true
// (xterm hibernates cheaply when CSS-hidden).
export function useTerminal(sessionId: string | null, mountTerminal: boolean = true): UseTerminalResult {
  const [status, setStatus] = useState<Status>('connecting');
  const [exitInfo, setExitInfo] = useState<{ code: number | null; signal: string | null } | null>(null);
  const [resumedFromSeq, setResumedFromSeq] = useState<number | null>(null);
  const [claudeEvents, setClaudeEvents] = useState<ClaudeSessionEvent[]>([]);
  const containerElRef = useRef<HTMLDivElement | null>(null);
  const sendInputRef = useRef<(data: string) => void>(() => {});
  const scrollTerminalToBottomRef = useRef<() => void>(() => {});
  const [terminalAtBottom, setTerminalAtBottom] = useState(true);
  // Re-mount xterm + WS whenever the active server flips. Same effect-key
  // pattern as sessionId — no need to share buffers across servers.
  const activeServerId = useServers((s) => s.activeId);

  useEffect(() => {
    if (!sessionId) return;

    // We do the entire setup in an async IIFE so we can `await` the
    // dynamic-import of xterm. The cleanup function returned from
    // useEffect captures `disposed` + the lazily-assigned `runCleanup`
    // closure — if the effect tears down before xterm finishes loading
    // (rare, but happens on rapid session switches), we just bail.
    let disposed = false;
    let runCleanup: (() => void) | null = null;

    (async () => {
      // xterm refs — null when mountTerminal=false. Every term.* call
      // is wrapped in `if (term)` so the WS / claudeEvents path runs
      // identically in either mode.
      let term: import('xterm').Terminal | null = null;
      let fit: import('@xterm/addon-fit').FitAddon | null = null;
      let scrollDisp: { dispose: () => void } | null = null;
      let dataDisp: { dispose: () => void } | null = null;
      let ro: ResizeObserver | null = null;

      if (mountTerminal) {
        const [xtermMod, serializeMod, fitMod] = await Promise.all([
          import('xterm'),
          import('@xterm/addon-serialize'),
          import('@xterm/addon-fit'),
          // CSS side-effect import — Vite injects the stylesheet on resolve.
          // Keeps the CSS in the same lazy chunk as the JS so the initial
          // bundle stays slim. Discard the unused module value via void.
          import('xterm/css/xterm.css').then(() => undefined)
        ]);
        if (disposed) return;
        const { Terminal } = xtermMod;
        const { SerializeAddon } = serializeMod;
        const { FitAddon } = fitMod;

        const container = containerElRef.current;
        if (container) {
          term = new Terminal({
            cursorBlink: true,
            fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
            fontSize: 13,
            scrollback: 5000,
            theme: {
              background: '#0a0a0a',
              foreground: '#e6e6e6'
            },
            allowProposedApi: true
          });
          const serialize = new SerializeAddon();
          fit = new FitAddon();
          term.loadAddon(serialize);
          term.loadAddon(fit);
          term.open(container);
          scrollDisp = term.onScroll(() => {
            const buf = term!.buffer.active;
            const atBottom = buf.viewportY >= buf.baseY - 2;
            setTerminalAtBottom((prev) => (prev === atBottom ? prev : atBottom));
          });
          setTerminalAtBottom(true);
          scrollTerminalToBottomRef.current = (): void => {
            try { term?.scrollToBottom(); } catch { /* ignore */ }
          };
        }
      }

      sendInputRef.current = (data: string): void => {
        if (ws && ws.readyState === ws.OPEN) {
          ws.send(JSON.stringify({ type: 'input', data }));
        }
      };

    setExitInfo(null);
    setResumedFromSeq(null);
    // Fresh session: start from empty event list. The server's replay
    // on connect will push every historical event back in.
    setClaudeEvents([]);

    let ws: WebSocket | null = null;
    let attempt = 0;
    let reconnectTimer: number | null = null;
    let ptyExited = false;
    // Microtask-batched buffer for incoming claudeEvent messages.
    // On a fresh WS connect the server replays the entire session
    // history (potentially thousands of events); coalescing into a
    // single setState avoids storming React.
    const pendingClaudeEvents: ClaudeSessionEvent[] = [];
    let claudeFlushScheduled = false;
    // `disposed` lives at the outer-effect scope (declared above the
    // async IIFE) so the cleanup function can flip it before xterm
    // finishes loading.
    // In-memory only. Each fresh page mount starts xterm at seq 0 (empty
    // buffer) and asks the server to replay everything. Within this mount,
    // transient WS reconnects (phone-lock, network blip) reuse the live
    // value so we ask only for the deltas xterm hasn't seen. We deliberately
    // do NOT persist this to localStorage: a previous tab's high-water-mark
    // would tell the server "client already has up to N" while xterm is
    // actually empty — causing the entire conversation to be skipped.
    let lastSeq = 0;
    // Running count of claudeEvents the client has ingested. Sent as
    // ?claudeEventsSince on WS reconnect so the server skips the
    // events we already have. Without this, every reconnect replayed
    // the full 5000-event ring (~tens of MB for a long session).
    let claudeEventsSeen = 0;

    // Sizing strategy: FitAddon measures cell metrics + container dims
    // and computes cols/rows that fill the visible terminal pane. We
    // then forward the new size to prettyd over WS so the PTY (and the
    // TUI inside it) redraws at the actual viewport size. Multi-client
    // implication: every client viewport is a candidate writer to the
    // PTY size — last-resize-wins on the server side. For a user
    // operating one client at a time (the common case) this just works;
    // if two clients are active at different sizes they'll fight and
    // the last one to resize "wins" until the other client resizes.
    //
    // Debouncing the WS send: ResizeObserver can fire many times during
    // a window-drag. We coalesce the sends so the PTY only receives a
    // resize 60ms after the last container change.
    let resizeSendTimer: number | null = null;
    const sendResize = (cols: number, rows: number): void => {
      if (ws && ws.readyState === ws.OPEN) {
        ws.send(JSON.stringify({ type: 'resize', cols, rows }));
      }
    };
    const applyFit = (): void => {
      if (!term || !fit) return;
      try {
        fit.fit();
      } catch {
        // Fit can throw if the container has zero dims (eg the pane is
        // display:none on an inactive tab). Ignore — when the pane is
        // visible again, the ResizeObserver fires and we try again.
        return;
      }
      if (resizeSendTimer !== null) window.clearTimeout(resizeSendTimer);
      resizeSendTimer = window.setTimeout(() => {
        resizeSendTimer = null;
        if (term) sendResize(term.cols, term.rows);
      }, 60);
    };

    const onResize = (): void => {
      requestAnimationFrame(applyFit);
    };

    const connect = (): void => {
      if (disposed || ptyExited) return;
      setStatus(attempt === 0 ? 'connecting' : 'reconnecting');
      const sock = new WebSocket(wsUrl(sessionId, lastSeq, claudeEventsSeen));
      ws = sock;

      sock.onopen = () => {
        if (sock !== ws) return;
        attempt = 0;
        setStatus('open');
        term?.focus();
        // hello (with PTY cols/rows) arrives next; that triggers the
        // zoom recompute. No need to do anything here size-wise.
      };

      sock.onmessage = (ev) => {
        if (sock !== ws) return;
        if (typeof ev.data !== 'string') return;
        let msg: ServerMsg;
        try {
          msg = JSON.parse(ev.data) as ServerMsg;
        } catch {
          return;
        }
        if (msg.type === 'hello') {
          setResumedFromSeq(msg.resumedFromSeq);
          // Initialize our local claudeEvents counter to the server's
          // starting index — the server caps initial replay to the
          // tail for long sessions, so we'd otherwise believe we'd
          // received 5000 events when we received 300, and the next
          // reconnect would skip 4700 events the server still wants
          // to push.
          claudeEventsSeen = msg.claudeReplayStart ?? claudeEventsSeen;
          if (term) {
            // First chance to fit the terminal to the visible container.
            requestAnimationFrame(() => {
              if (!term || !fit) return;
              try {
                fit.fit();
              } catch {
                if (msg.session.cols !== term.cols || msg.session.rows !== term.rows) {
                  try { term.resize(msg.session.cols, msg.session.rows); } catch { /* ignore */ }
                }
                return;
              }
              sendResize(term.cols, term.rows);
            });
          }
          return;
        }
        if (msg.type === 'output') {
          if (term) term.write(msg.data);
          lastSeq = msg.seq;
          return;
        }
        if (msg.type === 'gap') {
          if (term) {
            term.reset();
            term.writeln(
              `\x1b[2m[reconnect: missed ${msg.oldestAvailableSeq - 1 - lastSeq} chunks; ` +
              `resyncing from seq ${msg.oldestAvailableSeq}]\x1b[0m`
            );
          }
          lastSeq = msg.oldestAvailableSeq - 1;
          return;
        }
        if (msg.type === 'exit') {
          ptyExited = true;
          setExitInfo({ code: msg.code, signal: msg.signal });
          term?.writeln(
            `\r\n\x1b[2m[session exited code=${msg.code ?? '∅'} signal=${msg.signal ?? '∅'}]\x1b[0m`
          );
          return;
        }
        if (msg.type === 'error') {
          term?.writeln(`\r\n\x1b[31m[error] ${msg.message}\x1b[0m`);
          // "unknown session <id>" means this session id doesn't exist
          // server-side anymore — typically a stale pop-out window
          // pointing at a session that's since been killed/recreated.
          // Don't reconnect-spam forever; mark as terminally dead so
          // the user sees ONE error message instead of a recurring
          // wave. The exit handler below uses the same ptyExited gate.
          if (/unknown session/i.test(msg.message)) {
            ptyExited = true;
            setStatus('closed');
            setExitInfo({ code: null, signal: 'unknown-session' });
          }
          return;
        }
        if (msg.type === 'claudeEvent') {
          // Batch appends via a microtask. The server ships every
          // historical event on connect (could be thousands), and we
          // don't want each one to schedule its own re-render. Push
          // into a buffer ref, flush once per microtask.
          pendingClaudeEvents.push(msg.event);
          claudeEventsSeen += 1;
          if (!claudeFlushScheduled) {
            claudeFlushScheduled = true;
            queueMicrotask(() => {
              claudeFlushScheduled = false;
              const batch = pendingClaudeEvents.slice();
              pendingClaudeEvents.length = 0;
              setClaudeEvents((prev) => {
                const merged = [...prev, ...batch];
                return merged.length > CLAUDE_EVENT_CAP
                  ? merged.slice(-CLAUDE_EVENT_CAP)
                  : merged;
              });
            });
          }
          return;
        }
      };

      sock.onerror = () => {
        if (sock !== ws) return;
        setStatus('error');
      };

      sock.onclose = () => {
        if (sock !== ws) return;
        // Effect torn down (unmount, or re-mount for a mountTerminal /
        // server / session change): the REPLACEMENT effect owns `status`
        // now. Setting it here would race the new socket's onopen and can
        // stick the UI on 'closed' — disabling the input box — while the
        // new WS is actually live. Leave status to the new effect.
        if (disposed) return;
        if (ptyExited) {
          setStatus('closed');
          return;
        }
        const delay = RECONNECT_BACKOFF_MS[Math.min(attempt, RECONNECT_BACKOFF_MS.length - 1)] ?? 8000;
        attempt += 1;
        setStatus('reconnecting');
        reconnectTimer = window.setTimeout(connect, delay);
      };
    };

    if (term) {
      dataDisp = term.onData((d) => {
        if (ws && ws.readyState === ws.OPEN) {
          ws.send(JSON.stringify({ type: 'input', data: d }));
        }
      });
      window.addEventListener('resize', onResize);
      ro = new ResizeObserver(onResize);
      const c = containerElRef.current;
      if (c) ro.observe(c);
    }

    // Some browsers eagerly close WS on tab-hide and re-open on visible.
    // We treat 'visible' as a hint to nudge a reconnect if we're in
    // backoff — phone unlock often lands here before the timer fires.
    const onVis = (): void => {
      if (document.visibilityState === 'visible' && !ptyExited && !disposed) {
        if (!ws || ws.readyState >= WebSocket.CLOSING) {
          if (reconnectTimer !== null) {
            window.clearTimeout(reconnectTimer);
            reconnectTimer = null;
          }
          connect();
        }
      }
    };
    document.addEventListener('visibilitychange', onVis);

    // Snapshot-prefill: instead of opening the WS at seq=0 and watching
    // xterm fill top-to-bottom over 3-5s as every frame replays one at
    // a time, fetch the server-side serialized snapshot in ONE HTTP
    // request and write it to xterm in a single bulk call. Then open
    // the WS with lastSeq=<snapshot's seq> so we only receive deltas
    // going forward. Visually: buffer is just THERE on first paint.
    //
    // If the snapshot fetch fails for any reason (404, network error
    // mid-flight) we fall back to the original full-replay behavior —
    // worst case we get the slow path that used to be the only path.
    const prefillThenConnect = async (): Promise<void> => {
      if (term) {
        try {
          const snap = await fetchServerSnapshot(sessionId);
          if (disposed) return;
          if (snap && snap.seq > 0) {
            term.write(snap.text);
            lastSeq = snap.seq;
          }
        } catch { /* fall through to plain connect — full replay */ }
      }
      if (disposed) return;
      connect();
    };
    void prefillThenConnect();

    // Wire up the cleanup closure now that all locals (term, ws, etc.)
    // exist. The outer-effect cleanup invokes this if it's set.
    runCleanup = () => {
      document.removeEventListener('visibilitychange', onVis);
      window.removeEventListener('resize', onResize);
      ro?.disconnect();
      if (reconnectTimer !== null) window.clearTimeout(reconnectTimer);
      dataDisp?.dispose();
      scrollDisp?.dispose();
      try { ws?.close(); } catch { /* ignore */ }
      term?.dispose();
    };
    })();

    return () => {
      disposed = true;
      if (runCleanup) runCleanup();
    };
  }, [sessionId, activeServerId, mountTerminal]);

  const containerRef = useCallback((el: HTMLDivElement | null) => {
    containerElRef.current = el;
  }, []);

  return {
    containerRef,
    status,
    exitInfo,
    resumedFromSeq,
    sendInputRef,
    terminalAtBottom,
    scrollTerminalToBottomRef,
    claudeEvents
  };
}
