import { useCallback, useEffect, useRef, useState } from 'react';
// xterm + its CSS are dynamically imported below — Vite splits them into
// a separate chunk so the initial bundle (Pretty / Remote / Reflowed —
// the views most users hit first) doesn't pay xterm's ~250KB parse cost.
// On a fresh Android install over cellular, this is the difference
// between "instant tap-to-content" and "wait for the terminal lib to
// download even though you didn't open Terminal view."
import { wsMuxUrl, snapshot as fetchServerSnapshot } from '../api/prettyd';
import { attachSession, type SessionChannel, type MuxStatus } from '../lib/wsMux';
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
  // Imperative focus of xterm's hidden input textarea. Wired to a
  // pointer-down handler on the terminal pane so ANY click in the pane
  // (including the 8px padding ring, which isn't part of .xterm and so
  // never triggered xterm's own click-to-focus) puts the cursor in the
  // terminal. Without this, the shared-socket rewrite left tab switches
  // with no focus call at all (display toggle fires no 'open' status),
  // so you'd click a visible terminal and type into nothing.
  focusTerminalRef: { current: () => void };
  // Imperative re-fit (FitAddon) of xterm to its container. Fired when a
  // tab becomes active, since fits are gated to the visible session.
  fitTerminalRef: { current: () => void };
  // Stream of Claude Code's structured session events, captured from
  // the same WS we use for raw bytes. The server tails
  // ~/.claude/projects/<encoded-cwd>/<id>.jsonl and forwards each
  // typed event. RemoteView consumes this instead of the parser-
  // derived blocks — UUIDs are stable, content is structured, no
  // regex required. Empty for non-Claude sessions.
  claudeEvents: ClaudeSessionEvent[];
}

// Cap the in-memory claudeEvents array. The server's ring caps at 5000;
// without a matching client cap a days-long tab kept open accumulates tens
// of MB (tool_results carry full command/file output) and RemoteView's
// eventsToMessages re-walks the whole array on every batch. Keep the most
// recent N — the client counter (claudeEventsSeen) stays absolute, so
// reconnect resume is unaffected.
const CLAUDE_EVENT_CAP = 5000;

// Connection model: every session in this window shares ONE multiplexed
// WebSocket (lib/wsMux) — frames are sessionId-tagged, tmux-style. This
// hook attaches its session to that shared socket and receives exactly
// the ServerMsg stream it used to read off a private socket. With 50+
// sessions mounted, the old one-socket-per-session shape meant reconnect
// herds on every daemon restart and proxy pile-ups that left "open"
// sockets dead (typing went nowhere).
//
// `mountTerminal=true` enables full xterm rendering: dynamic import,
// term.open(container), FitAddon resize, snapshot prefill, the works.
// When `false`, the hook still attaches to the mux socket and ingests
// claudeEvents (so Remote view stays live) — but skips the ~250KB xterm
// instance, its DOM tree, and the FitAddon ResizeObserver.
//
// `isActive` is whether this is the session the user is currently viewing.
// Only the active session replays Claude conversation *history* on attach;
// hidden sessions attach live-only. Otherwise every mounted session dumps
// ~300 events on page load (32 sessions ≈ 20MB at once → frozen page,
// laggy typing). Read through a ref (not an effect dependency) so flipping
// active doesn't tear down + rebuild xterm on every tab switch — the burst
// only matters at page-load attach, and each session attaches once with
// its mount-time isActive. (Trade-off: a session hidden at load backfills
// its Pretty history only on the next reconnect, not instantly on switch —
// fine; the terminal view doesn't use this path at all.)
export function useTerminal(sessionId: string | null, mountTerminal: boolean = true, isActive: boolean = true): UseTerminalResult {
  const [status, setStatus] = useState<Status>('connecting');
  const [exitInfo, setExitInfo] = useState<{ code: number | null; signal: string | null } | null>(null);
  const [resumedFromSeq, setResumedFromSeq] = useState<number | null>(null);
  const [claudeEvents, setClaudeEvents] = useState<ClaudeSessionEvent[]>([]);
  const containerElRef = useRef<HTMLDivElement | null>(null);
  // Current activeness, readable from the attach closure without making it
  // an effect dependency. Updated every render below.
  const isActiveRef = useRef(isActive);
  isActiveRef.current = isActive;
  const sendInputRef = useRef<(data: string) => void>(() => {});
  const scrollTerminalToBottomRef = useRef<() => void>(() => {});
  const focusTerminalRef = useRef<() => void>(() => {});
  // Re-subscribe this session's mux stream with flags recomputed for the
  // current activeness, and re-fit the terminal — invoked when isActive
  // flips (tab switch). Set inside the mount effect once the channel
  // exists; no-ops until then.
  const reattachRef = useRef<(active: boolean) => void>(() => {});
  const fitTerminalRef = useRef<() => void>(() => {});
  const [terminalAtBottom, setTerminalAtBottom] = useState(true);
  // Re-attach whenever the active server flips. Same effect-key pattern
  // as sessionId — no need to share buffers across servers.
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
      // is wrapped in `if (term)` so the mux / claudeEvents path runs
      // identically in either mode.
      let term: import('@xterm/xterm').Terminal | null = null;
      let fit: import('@xterm/addon-fit').FitAddon | null = null;
      let scrollDisp: { dispose: () => void } | null = null;
      let dataDisp: { dispose: () => void } | null = null;
      let ro: ResizeObserver | null = null;

      if (mountTerminal) {
        const [xtermMod, serializeMod, fitMod, webglMod, canvasMod] = await Promise.all([
          import('@xterm/xterm'),
          import('@xterm/addon-serialize'),
          import('@xterm/addon-fit'),
          // GPU renderers (maintained @xterm/* 5.5 generation, matching the
          // core). Kept in the same lazy chunk. See the loadAddon block
          // after open() — this is THE fix for slow typing.
          import('@xterm/addon-webgl'),
          import('@xterm/addon-canvas'),
          // CSS side-effect import — Vite injects the stylesheet on resolve.
          // Keeps the CSS in the same lazy chunk as the JS so the initial
          // bundle stays slim. Discard the unused module value via void.
          import('@xterm/xterm/css/xterm.css').then(() => undefined)
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
          // GPU renderer — THE fix for slow typing. The default DOM renderer
          // rebuilds one <span>-run-per-style for every dirty row each frame
          // and reflows them; at 254×127 with Claude's full-pane repaint that
          // is thousands of DOM nodes + layout per keystroke (tens of ms of
          // main-thread work = the browser-side echo lag). WebGL/canvas
          // rasterize glyphs to a single canvas with no per-cell DOM or
          // reflow. MUST load AFTER open(). Chain: webgl → canvas → DOM, all
          // in try/catch so a missing GPU context degrades safely to the old
          // behavior instead of blanking the terminal. With the live-session
          // cap (≤3 mounted), the WebGL per-page context limit isn't a risk;
          // term.dispose() (runCleanup) frees the context on unmount.
          try {
            const webgl = new webglMod.WebglAddon();
            webgl.onContextLoss(() => {
              try { webgl.dispose(); } catch { /* ignore */ }
              try { term?.loadAddon(new canvasMod.CanvasAddon()); } catch { /* stay on DOM */ }
            });
            term.loadAddon(webgl);
          } catch {
            try { term.loadAddon(new canvasMod.CanvasAddon()); } catch { /* stay on DOM */ }
          }
          scrollDisp = term.onScroll(() => {
            const buf = term!.buffer.active;
            const atBottom = buf.viewportY >= buf.baseY - 2;
            setTerminalAtBottom((prev) => (prev === atBottom ? prev : atBottom));
          });
          setTerminalAtBottom(true);
          scrollTerminalToBottomRef.current = (): void => {
            try { term?.scrollToBottom(); } catch { /* ignore */ }
          };
          focusTerminalRef.current = (): void => {
            try { term?.focus(); } catch { /* ignore */ }
          };
        }
      }

      // The session's channel on the shared mux socket. Assigned by
      // attachNow below; input before then is dropped (matches the old
      // "socket not open yet" behavior).
      let channel: SessionChannel | null = null;

      sendInputRef.current = (data: string): void => {
        channel?.sendInput(data);
      };

      setExitInfo(null);
      setResumedFromSeq(null);
      // Fresh session: start from empty event list. The server's replay
      // on attach will push every historical event back in.
      setClaudeEvents([]);

      let ptyExited = false;
      // Microtask-batched buffer for incoming claudeEvent messages.
      // On a fresh attach the server replays history (potentially
      // thousands of events); coalescing into a single setState avoids
      // storming React.
      const pendingClaudeEvents: ClaudeSessionEvent[] = [];
      let claudeFlushScheduled = false;
      // In-memory only. Each fresh page mount starts xterm at seq 0 (empty
      // buffer) and asks the server to replay everything. Within this mount,
      // transient reconnects (phone-lock, network blip) reuse the live value
      // so we ask only for the deltas xterm hasn't seen. Deliberately NOT
      // persisted to localStorage: a previous tab's high-water-mark would
      // tell the server "client already has up to N" while xterm is
      // actually empty — causing the entire conversation to be skipped.
      let lastSeq = 0;
      // Running count of claudeEvents the client has ingested. The mux
      // manager reads it via getResume() on every (re)attach so the
      // server skips events we already have.
      let claudeEventsSeen = 0;

      // Output coalescing: a busy TUI emits MANY small PTY frames per
      // keystroke (each ~1KB). Writing each one to xterm separately multiplies
      // VT-parser invocations and render scheduling. Buffer incoming frames
      // and flush them as ONE term.write per animation frame, so the parser
      // and renderer run once per painted frame instead of N times. lastSeq is
      // tracked per-message (above) so resume is unaffected by the batching.
      let pendingOutput: string[] = [];
      let outputRaf: number | null = null;
      const flushOutput = (): void => {
        outputRaf = null;
        if (!term || pendingOutput.length === 0) return;
        const data = pendingOutput.length === 1 ? pendingOutput[0]! : pendingOutput.join('');
        pendingOutput = [];
        term.write(data);
      };

      // Sizing strategy: FitAddon measures cell metrics + container dims
      // and computes cols/rows that fill the visible terminal pane. We
      // then forward the new size to prettyd so the PTY (and the TUI
      // inside it) redraws at the actual viewport size. Last-resize-wins
      // across clients. Debounced: ResizeObserver can fire many times
      // during a window-drag; the PTY receives one resize 60ms after the
      // last container change.
      let resizeSendTimer: number | null = null;
      const sendResize = (cols: number, rows: number): void => {
        channel?.sendResize(cols, rows);
      };
      const applyFit = (): void => {
        if (!term || !fit) return;
        // Only the viewed session fits/resizes. A window-resize fires the
        // listener on EVERY mounted session; without this gate, all ~36
        // run fit.fit() — each a synchronous layout measurement — dozens of
        // times per drag (the resize was ~5s instead of ~500ms). Hidden
        // panes are display:none so fit would throw on them anyway, but the
        // measurement attempt is the cost. Fit-on-activate (the isActive
        // effect) sizes a session the moment it becomes visible.
        if (!isActiveRef.current) return;
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
      fitTerminalRef.current = applyFit;

      const onMessage = (msg: ServerMsg): void => {
        if (disposed) return;
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
          lastSeq = msg.seq;
          if (term) {
            pendingOutput.push(msg.data);
            if (outputRaf === null) outputRaf = requestAnimationFrame(flushOutput);
          }
          return;
        }
        if (msg.type === 'gap') {
          // Resync wipes the screen — any buffered-but-unwritten frames are
          // now stale; drop them and cancel the pending flush.
          pendingOutput = [];
          if (outputRaf !== null) { cancelAnimationFrame(outputRaf); outputRaf = null; }
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
          // Flush any buffered output so the final bytes show before the
          // exit banner, then stop the coalescer.
          flushOutput();
          if (outputRaf !== null) { cancelAnimationFrame(outputRaf); outputRaf = null; }
          ptyExited = true;
          setExitInfo({ code: msg.code, signal: msg.signal });
          setStatus('closed');
          term?.writeln(
            `\r\n\x1b[2m[session exited code=${msg.code ?? '∅'} signal=${msg.signal ?? '∅'}]\x1b[0m`
          );
          // The server auto-detaches an exited session from the mux
          // socket; detach locally too so the manager forgets us (and
          // can close the socket when nothing else is attached).
          channel?.detach();
          return;
        }
        if (msg.type === 'error') {
          term?.writeln(`\r\n\x1b[31m[error] ${msg.message}\x1b[0m`);
          // "unknown session <id>" means this session id doesn't exist
          // server-side anymore — typically a stale pop-out window
          // pointing at a session that's since been killed/recreated.
          // Mark terminally dead so the user sees ONE error message
          // instead of a reconnect-spam wave.
          if (/unknown session/i.test(msg.message)) {
            ptyExited = true;
            setStatus('closed');
            setExitInfo({ code: null, signal: 'unknown-session' });
            channel?.detach();
          }
          return;
        }
        if (msg.type === 'claudeEvent') {
          // Only the viewed session folds events into React state. A hidden
          // session's RemoteView isn't on screen, and without this guard a
          // few busy background sessions (e.g. the sw-lanes builders) storm
          // React — 35 invisible RemoteViews re-rendering per event — which
          // starves the active terminal's main thread and shows up as
          // laggy input echo. claudeEventsSeen is NOT advanced for dropped
          // events, so when the tab is reactivated reattach() asks the
          // server to replay from where we left off and the Pretty view
          // catches up. (Live output is already gated the same way.)
          if (!isActiveRef.current) return;
          // Batch appends via a microtask. The server ships history on
          // attach (could be thousands of events); we don't want each
          // one to schedule its own re-render.
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

      const onStatus = (s: MuxStatus): void => {
        // Once this session has terminally ended (exit / unknown
        // session) the shared socket's state no longer describes us.
        if (disposed || ptyExited) return;
        setStatus(s);
        if (s === 'open') term?.focus();
      };

      if (term) {
        dataDisp = term.onData((d) => {
          channel?.sendInput(d);
        });
        // macOS line-editing: xterm doesn't map Cmd+Backspace, so ⌘⌫
        // silently does nothing in the terminal (it works in tmux/iTerm only
        // because the native terminal maps it). Send Ctrl+U — the universal
        // "delete to start of line" — so ⌘⌫ wipes the current input line like
        // it does everywhere else on macOS. Return false so xterm doesn't
        // also process the key; everything else falls through untouched.
        term.attachCustomKeyEventHandler((e) => {
          if (e.type === 'keydown' && e.metaKey && !e.ctrlKey && !e.altKey && e.key === 'Backspace') {
            channel?.sendInput('\x15');
            return false;
          }
          return true;
        });
        window.addEventListener('resize', onResize);
        ro = new ResizeObserver(onResize);
        const c = containerElRef.current;
        if (c) ro.observe(c);
      }

      const getResume = (): { lastSeq: number; claudeEventsSince: number; outputReplay: boolean; claudeReplay: boolean } => ({
        lastSeq,
        claudeEventsSince: claudeEventsSeen,
        // Raw PTY bytes (replay AND live) only for the session the user is
        // actually viewing. Without the isActive gate, every mounted
        // terminal replays its output ring on page load / reconnect — at
        // 36 sessions that backlog drains slowly over Tailscale and the
        // keystroke echo queues behind it (the "typing is 5s" symptom).
        // No terminal mounted (Pretty-only) → no bytes at all. A hidden
        // session catches up via snapshot-prefill when it's reactivated.
        outputReplay: term !== null && isActiveRef.current,
        // Likewise only the viewed session replays Claude history (the
        // 20MB page-load burst this already fixed). Ref, not the prop, so
        // tab switches re-attach via reattach() instead of re-mounting.
        claudeReplay: isActiveRef.current
      });

      // Snapshot-prefill: instead of attaching at seq=0 and watching xterm
      // fill top-to-bottom as every frame replays one at a time, fetch the
      // server-side serialized snapshot in ONE HTTP request and write it in
      // a single bulk call, then attach with lastSeq=<snapshot's seq> so we
      // only receive deltas. Visually: the buffer is just THERE on first
      // paint. Reused on reactivation (a hidden terminal had output
      // suppressed, so it's stale — reset + reprime from the snapshot).
      const attachNow = async (doPrefill: boolean): Promise<void> => {
        if (disposed) return;
        channel?.detach();
        channel = null;
        if (doPrefill && term) {
          try {
            const snap = await fetchServerSnapshot(sessionId);
            if (disposed) return;
            if (snap && snap.seq > 0) {
              term.reset();
              term.write(snap.text);
              lastSeq = snap.seq;
            }
          } catch { /* fall through to plain attach — full replay */ }
        }
        if (disposed) return;
        channel = attachSession(wsMuxUrl(), sessionId, { onMessage, onStatus, getResume });
      };
      // Re-subscribe with flags recomputed for current activeness. Becoming
      // active → prefill (the terminal was frozen while hidden) + the
      // server starts streaming output again; going inactive → re-attach
      // output-less so the server stops sending this session's bytes.
      reattachRef.current = (active: boolean): void => { void attachNow(active && term !== null); };
      void attachNow(true);

      // Wire up the cleanup closure now that all locals exist. The
      // outer-effect cleanup invokes this if it's set.
      runCleanup = () => {
        window.removeEventListener('resize', onResize);
        ro?.disconnect();
        if (resizeSendTimer !== null) window.clearTimeout(resizeSendTimer);
        if (outputRaf !== null) { cancelAnimationFrame(outputRaf); outputRaf = null; }
        dataDisp?.dispose();
        scrollDisp?.dispose();
        channel?.detach();
        term?.dispose();
      };
    })();

    return () => {
      disposed = true;
      if (runCleanup) runCleanup();
    };
  }, [sessionId, activeServerId, mountTerminal]);

  // Activeness changes are NOT a mount-effect dependency (that would
  // dispose + rebuild xterm on every tab switch). Instead, re-subscribe
  // the mux stream with output gated to the active session, and fit the
  // terminal the moment it becomes visible. Skip the initial run — the
  // mount effect already did the first attach.
  const activeFirstRunRef = useRef(true);
  useEffect(() => {
    if (activeFirstRunRef.current) { activeFirstRunRef.current = false; return; }
    reattachRef.current(isActive);
    if (isActive) {
      const id = requestAnimationFrame(() => fitTerminalRef.current());
      return () => cancelAnimationFrame(id);
    }
    return undefined;
  }, [isActive]);

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
    focusTerminalRef,
    fitTerminalRef,
    claudeEvents
  };
}
