import { useCallback, useEffect, useRef, useState } from 'react';
import { Terminal } from 'xterm';
import { FitAddon } from '@xterm/addon-fit';
import 'xterm/css/xterm.css';
import { wsUrl } from '../api/prettyd';
import type { ServerCtrlMsg } from '../types';

type Status = 'connecting' | 'open' | 'closed' | 'error';

interface UseTerminalResult {
  containerRef: (el: HTMLDivElement | null) => void;
  status: Status;
  exitInfo: { code: number | null; signal: string | null } | null;
}

// Mounts an xterm.js terminal into a div and binds it to a prettyd session
// over WebSocket. Phase 1: raw passthrough — every text frame from the
// server is written to xterm verbatim, and every onData event is sent
// back as a JSON input message. No replay, no sequencing yet.
export function useTerminal(sessionId: string | null): UseTerminalResult {
  const [status, setStatus] = useState<Status>('connecting');
  const [exitInfo, setExitInfo] = useState<{ code: number | null; signal: string | null } | null>(null);
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

    setStatus('connecting');
    setExitInfo(null);

    const ws = new WebSocket(wsUrl(sessionId));

    const sendResize = (): void => {
      try {
        const { cols, rows } = term;
        ws.send(JSON.stringify({ type: 'resize', cols, rows }));
      } catch {
        // socket not open yet — onopen will trigger an initial resize
      }
    };

    const onResize = (): void => {
      try {
        fit.fit();
      } catch {
        // container may be hidden / detached
      }
      sendResize();
    };

    ws.onopen = () => {
      setStatus('open');
      sendResize();
      term.focus();
    };
    ws.onerror = () => setStatus('error');
    ws.onclose = () => setStatus('closed');
    ws.onmessage = (ev) => {
      const data = ev.data;
      if (typeof data === 'string') {
        // Try to parse as JSON ctrl message; fall through to raw output.
        if (data.startsWith('{')) {
          try {
            const msg = JSON.parse(data) as ServerCtrlMsg;
            if (msg.type === 'exit') {
              setExitInfo({ code: msg.code, signal: msg.signal });
              term.writeln(`\r\n\x1b[2m[session exited code=${msg.code ?? '∅'} signal=${msg.signal ?? '∅'}]\x1b[0m`);
              return;
            }
            if (msg.type === 'error') {
              term.writeln(`\r\n\x1b[31m[error] ${msg.message}\x1b[0m`);
              return;
            }
            if (msg.type === 'hello') {
              return; // metadata only
            }
          } catch {
            // not JSON — treat as raw output
          }
        }
        term.write(data);
      } else if (data instanceof ArrayBuffer) {
        term.write(new Uint8Array(data));
      } else if (data instanceof Blob) {
        data.arrayBuffer().then((buf) => term.write(new Uint8Array(buf)));
      }
    };

    const dataDisp = term.onData((d) => {
      if (ws.readyState === ws.OPEN) {
        ws.send(JSON.stringify({ type: 'input', data: d }));
      }
    });

    window.addEventListener('resize', onResize);
    const ro = new ResizeObserver(onResize);
    ro.observe(container);

    return () => {
      window.removeEventListener('resize', onResize);
      ro.disconnect();
      dataDisp.dispose();
      try { ws.close(); } catch { /* ignore */ }
      term.dispose();
    };
  }, [sessionId]);

  const containerRef = useCallback((el: HTMLDivElement | null) => {
    containerElRef.current = el;
  }, []);

  return { containerRef, status, exitInfo };
}
