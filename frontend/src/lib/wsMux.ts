// Multiplexed WebSocket manager — ONE socket per (window, server) carrying
// every attached session's traffic as sessionId-tagged frames.
//
// Why: the previous shape opened one WebSocket per mounted SessionView.
// With orchestrators pushing the session count past 50, that meant 50+
// parallel sockets per window — reconnect herds on every daemon restart,
// and a dev-proxy/socket pile-up that left "open" sockets dead (input
// silently dropped). tmux solves the same problem with a single
// multiplexed client connection; this is that, for the browser.
//
// useTerminal attaches each session via attachSession() and receives the
// exact same ServerMsg stream it used to read off its private socket.
// The manager owns: connection lifecycle, exponential backoff, the
// visibilitychange reconnect nudge (phone unlock), and re-attaching every
// registered session after a reconnect (asking each for its current
// resume point so replays stay incremental).

import type { ServerMsg, MuxClientMsg } from '../types';

export type MuxStatus = 'connecting' | 'open' | 'reconnecting' | 'closed' | 'error';

export interface SessionHandlers {
  onMessage: (msg: ServerMsg) => void;
  onStatus: (status: MuxStatus) => void;
  // Called on (re)connect to build the attach frame — returns where this
  // session's client-side state is, so the server replays only deltas.
  // outputReplay=false means "no raw PTY bytes at all" (no terminal is
  // mounted for this session; only claudeEvents are consumed).
  // claudeReplay=false means "no Claude history replay" (this session is
  // hidden; only the viewed session loads its conversation history).
  getResume: () => { lastSeq: number; claudeEventsSince: number; outputReplay: boolean; claudeReplay: boolean };
}

export interface SessionChannel {
  sendInput(data: string): void;
  sendResize(cols: number, rows: number): void;
  detach(): void;
}

const RECONNECT_BACKOFF_MS = [500, 1000, 2000, 4000, 8000] as const;

// Cap on input/resize frames buffered while the socket is down. Keystrokes
// are tiny; this is seconds of furious typing. Bounded so a socket that
// never comes back can't grow it without limit.
const OUTBOX_CAP = 2000;

class MuxManager {
  private ws: WebSocket | null = null;
  private status: MuxStatus = 'connecting';
  private attempt = 0;
  private reconnectTimer: number | null = null;
  private readonly sessions = new Map<string, SessionHandlers>();
  // Input/resize typed while the socket isn't OPEN (initial connect, or a
  // reconnect blip after phone-sleep / network handoff). Without this they
  // were silently dropped — you'd click a terminal that LOOKS ready (the
  // snapshot is already painted) and type into the void until the socket
  // happened to be OPEN. Flushed in order on reopen, after re-attach.
  private readonly outbox: MuxClientMsg[] = [];
  private readonly onVis = (): void => {
    // Phone unlock / tab foreground: if the socket died while backgrounded,
    // reconnect immediately instead of waiting out the backoff timer.
    if (document.visibilityState !== 'visible') return;
    if (this.sessions.size === 0) return;
    if (!this.ws || this.ws.readyState >= WebSocket.CLOSING) {
      if (this.reconnectTimer !== null) {
        window.clearTimeout(this.reconnectTimer);
        this.reconnectTimer = null;
      }
      this.connect();
    }
  };

  constructor(private readonly url: string) {
    document.addEventListener('visibilitychange', this.onVis);
  }

  attach(sessionId: string, handlers: SessionHandlers): SessionChannel {
    this.sessions.set(sessionId, handlers);
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      handlers.onStatus('open');
      this.sendAttach(sessionId, handlers);
    } else {
      handlers.onStatus(this.status === 'open' ? 'connecting' : this.status);
      if (!this.ws || this.ws.readyState >= WebSocket.CLOSING) this.connect();
    }
    return {
      sendInput: (data: string) => this.send({ type: 'input', data, sessionId }),
      sendResize: (cols: number, rows: number) => this.send({ type: 'resize', cols, rows, sessionId }),
      detach: () => {
        this.sessions.delete(sessionId);
        this.send({ type: 'detach', sessionId });
        if (this.sessions.size === 0) this.shutdownSocket();
      }
    };
  }

  private send(msg: MuxClientMsg): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
      return;
    }
    // Socket not OPEN. Queue input & resize so they're delivered on reopen
    // instead of silently lost. attach/detach are NOT queued — they're
    // rebuilt from the live `sessions` map on reconnect (sendAttach in
    // onopen), so a stale queued attach/detach would only fight that.
    if (msg.type === 'input' || msg.type === 'resize') {
      this.outbox.push(msg);
      if (this.outbox.length > OUTBOX_CAP) {
        this.outbox.splice(0, this.outbox.length - OUTBOX_CAP);
      }
      // A queued keystroke means we WANT a live socket. If none is pending,
      // kick a connect now rather than waiting for the next backoff tick.
      if (!this.ws || this.ws.readyState >= WebSocket.CLOSING) {
        if (this.reconnectTimer === null) this.connect();
      }
    }
  }

  private sendAttach(sessionId: string, handlers: SessionHandlers): void {
    const r = handlers.getResume();
    const msg: MuxClientMsg = { type: 'attach', sessionId };
    if (r.lastSeq > 0) msg.lastSeq = r.lastSeq;
    if (r.claudeEventsSince > 0) msg.claudeEventsSince = r.claudeEventsSince;
    if (!r.outputReplay) msg.outputReplay = false;
    if (!r.claudeReplay) msg.claudeReplay = false;
    this.send(msg);
  }

  private setStatus(s: MuxStatus): void {
    this.status = s;
    for (const h of this.sessions.values()) h.onStatus(s);
  }

  private connect(): void {
    if (this.sessions.size === 0) return;
    this.setStatus(this.attempt === 0 ? 'connecting' : 'reconnecting');
    const sock = new WebSocket(this.url);
    this.ws = sock;

    sock.onopen = () => {
      if (sock !== this.ws) return;
      this.attempt = 0;
      this.setStatus('open');
      // (Re-)attach every registered session at its current resume point.
      for (const [id, handlers] of this.sessions) this.sendAttach(id, handlers);
      // Then flush input/resize typed while we were down — AFTER re-attach,
      // so the server has each session subscribed on this connection first.
      if (this.outbox.length > 0) {
        const pending = this.outbox.splice(0, this.outbox.length);
        for (const m of pending) {
          if (sock.readyState === WebSocket.OPEN) sock.send(JSON.stringify(m));
        }
      }
    };

    sock.onmessage = (ev) => {
      if (sock !== this.ws) return;
      if (typeof ev.data !== 'string') return;
      let msg: ServerMsg;
      try {
        msg = JSON.parse(ev.data) as ServerMsg;
      } catch {
        return;
      }
      const sid = (msg as { sessionId?: string }).sessionId;
      if (!sid) return; // mux frames are always tagged
      this.sessions.get(sid)?.onMessage(msg);
    };

    sock.onerror = () => {
      if (sock !== this.ws) return;
      this.setStatus('error');
    };

    sock.onclose = () => {
      if (sock !== this.ws) return;
      this.ws = null;
      if (this.sessions.size === 0) {
        this.setStatus('closed');
        return;
      }
      const delay = RECONNECT_BACKOFF_MS[Math.min(this.attempt, RECONNECT_BACKOFF_MS.length - 1)] ?? 8000;
      this.attempt += 1;
      this.setStatus('reconnecting');
      this.reconnectTimer = window.setTimeout(() => {
        this.reconnectTimer = null;
        this.connect();
      }, delay);
    };
  }

  private shutdownSocket(): void {
    if (this.reconnectTimer !== null) {
      window.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    // No sessions left → drop any frames still queued for a dead window.
    this.outbox.length = 0;
    const sock = this.ws;
    this.ws = null; // socket handlers no-op via identity checks
    try { sock?.close(); } catch { /* ignore */ }
  }
}

// One manager per distinct mux URL (i.e. per server). Switching the
// active server yields a different URL → its own socket; the previous
// manager idles out when its last session detaches.
const managers = new Map<string, MuxManager>();

export function attachSession(muxUrl: string, sessionId: string, handlers: SessionHandlers): SessionChannel {
  let m = managers.get(muxUrl);
  if (!m) {
    m = new MuxManager(muxUrl);
    managers.set(muxUrl, m);
  }
  return m.attach(sessionId, handlers);
}
