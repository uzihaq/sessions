import { useCallback, useEffect, useRef, useState } from 'react';
import { Terminal } from 'xterm';
import { FitAddon } from '@xterm/addon-fit';
import 'xterm/css/xterm.css';
import { wsUrl } from '../api/prettyd';
import { readLastSeq, writeLastSeq, clearLastSeq } from '../lib/seqStorage';
import type { ServerMsg } from '../types';

type Status = 'connecting' | 'open' | 'reconnecting' | 'closed' | 'error';

interface UseTerminalResult {
  containerRef: (el: HTMLDivElement | null) => void;
  status: Status;
  exitInfo: { code: number | null; signal: string | null } | null;
  resumedFromSeq: number | null;
}

const RECONNECT_BACKOFF_MS = [500, 1000, 2000, 4000, 8000] as const;

// Phase 2: xterm.js mounted into a div, bound to a prettyd session over WS.
// Every output frame carries a seq#; we persist the latest in localStorage
// so a phone-lock-induced disconnect can resume from where we left off.
//
// On WS close that isn't a clean PTY exit, the hook reconnects with
// exponential backoff, passing lastSeq so the server replays only the
// chunks the terminal actually missed.
export function useTerminal(sessionId: string | null): UseTerminalResult {
  const [status, setStatus] = useState<Status>('connecting');
  const [exitInfo, setExitInfo] = useState<{ code: number | null; signal: string | null } | null>(null);
  const [resumedFromSeq, setResumedFromSeq] = useState<number | null>(null);
  const containerElRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!sessionId) return;
    const container = containerElRef.current;
    if (!container) return;

    const term = new Terminal({
      cursorBlink: true,
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
      fontSize: 13,
      theme: {
        background: '#0a0a0a',
        foreground: '#e6e6e6'
      },
      allowProposedApi: true
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(container);
    fit.fit();

    setExitInfo(null);
    setResumedFromSeq(null);

    let ws: WebSocket | null = null;
    let attempt = 0;
    let reconnectTimer: number | null = null;
    let disposed = false;
    let ptyExited = false;
    let lastSeq = readLastSeq(sessionId);

    const sendResize = (): void => {
      if (!ws || ws.readyState !== ws.OPEN) return;
      try {
        const { cols, rows } = term;
        ws.send(JSON.stringify({ type: 'resize', cols, rows }));
      } catch {
        // socket flapped between the readyState check and the send
      }
    };

    const onResize = (): void => {
      try { fit.fit(); } catch { /* container hidden */ }
      sendResize();
    };

    const connect = (): void => {
      if (disposed || ptyExited) return;
      setStatus(attempt === 0 ? 'connecting' : 'reconnecting');
      const sock = new WebSocket(wsUrl(sessionId, lastSeq));
      ws = sock;

      sock.onopen = () => {
        if (sock !== ws) return;
        attempt = 0;
        setStatus('open');
        sendResize();
        term.focus();
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
          return;
        }
        if (msg.type === 'output') {
          term.write(msg.data);
          lastSeq = msg.seq;
          writeLastSeq(sessionId, msg.seq);
          return;
        }
        if (msg.type === 'gap') {
          // We asked for a seq the server has aged out. The cleanest
          // recovery is to reset the screen and replay the live tail.
          term.reset();
          term.writeln(
            `\x1b[2m[reconnect: missed ${msg.oldestAvailableSeq - 1 - lastSeq} chunks; ` +
            `resyncing from seq ${msg.oldestAvailableSeq}]\x1b[0m`
          );
          lastSeq = msg.oldestAvailableSeq - 1;
          return;
        }
        if (msg.type === 'exit') {
          ptyExited = true;
          setExitInfo({ code: msg.code, signal: msg.signal });
          term.writeln(
            `\r\n\x1b[2m[session exited code=${msg.code ?? '∅'} signal=${msg.signal ?? '∅'}]\x1b[0m`
          );
          // The session is over — drop the persisted seq so a new
          // session reusing the same id (in the unlikely event of a
          // collision after restart) starts clean.
          clearLastSeq(sessionId);
          return;
        }
        if (msg.type === 'error') {
          term.writeln(`\r\n\x1b[31m[error] ${msg.message}\x1b[0m`);
          return;
        }
      };

      sock.onerror = () => {
        if (sock !== ws) return;
        setStatus('error');
      };

      sock.onclose = () => {
        if (sock !== ws) return;
        if (disposed || ptyExited) {
          setStatus('closed');
          return;
        }
        const delay = RECONNECT_BACKOFF_MS[Math.min(attempt, RECONNECT_BACKOFF_MS.length - 1)] ?? 8000;
        attempt += 1;
        setStatus('reconnecting');
        reconnectTimer = window.setTimeout(connect, delay);
      };
    };

    const dataDisp = term.onData((d) => {
      if (ws && ws.readyState === ws.OPEN) {
        ws.send(JSON.stringify({ type: 'input', data: d }));
      }
    });

    window.addEventListener('resize', onResize);
    const ro = new ResizeObserver(onResize);
    ro.observe(container);

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

    connect();

    return () => {
      disposed = true;
      document.removeEventListener('visibilitychange', onVis);
      window.removeEventListener('resize', onResize);
      ro.disconnect();
      if (reconnectTimer !== null) window.clearTimeout(reconnectTimer);
      dataDisp.dispose();
      try { ws?.close(); } catch { /* ignore */ }
      term.dispose();
    };
  }, [sessionId]);

  const containerRef = useCallback((el: HTMLDivElement | null) => {
    containerElRef.current = el;
  }, []);

  return { containerRef, status, exitInfo, resumedFromSeq };
}
