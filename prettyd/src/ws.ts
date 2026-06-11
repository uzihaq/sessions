import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type WebSocket } from 'ws';
import { getSession, writeInput, resize, type OutputEvent, type SessionHandle } from './sessions.js';
import type { ClaudeSessionEvent } from './sessionFileWatcher.js';
import { PROTOCOL_VERSION, type ClientMsg, type ServerMsg } from './types.js';

const wss = new WebSocketServer({ noServer: true });

function send(ws: WebSocket, msg: ServerMsg): void {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
}

// Attach one session's stream to a socket: replay (raw output from
// lastSeq, claude events from claudeEventsSince) then live events. Both
// connection modes go through here; mux mode tags every message with the
// sessionId so the client can route. Returns a detach() that removes the
// listeners, or null if the session already exited (terminal state was
// sent; nothing live to subscribe to).
function attachSessionStream(
  ws: WebSocket,
  session: SessionHandle,
  opts: {
    lastSeq: number;
    claudeEventsSince: number;
    tagSessionId?: string;
    onExited?: () => void;
    // When false, raw PTY bytes are suppressed for this attach — no
    // replay AND no live output frames. Structured claudeEvents, exit,
    // and hello still flow. See the attach message in types.ts.
    includeOutput?: boolean;
  }
): (() => void) | null {
  const tag = opts.tagSessionId !== undefined ? { sessionId: opts.tagSessionId } : {};
  const includeOutput = opts.includeOutput !== false;
  const replay = session.log.since(opts.lastSeq);

  // Claude-event replay window. Indices are ABSOLUTE (claudeEventBase +
  // array index) so they survive the 5000-cap front-trim; map the
  // client's absolute resume point into a local offset. Fresh attaches
  // (since=0) cap the initial replay to the tail — long sessions hold
  // thousands of events and RemoteView renders ~50 anyway; older history
  // stays reachable via HTTP /events.
  const INITIAL_REPLAY_CAP = 300;
  const base = session.claudeEventBase;
  const len = session.claudeEventLog.length;
  const claudeEventsCount = base + len;
  const localStart = opts.claudeEventsSince > 0
    ? Math.max(0, Math.min(opts.claudeEventsSince - base, len))
    : Math.max(0, len - INITIAL_REPLAY_CAP);
  const claudeReplayStart = base + localStart;

  send(ws, {
    type: 'hello',
    protocol: PROTOCOL_VERSION,
    session: session.info,
    currentSeq: replay.current,
    resumedFromSeq: opts.lastSeq > 0 ? opts.lastSeq : null,
    claudeEventsCount,
    claudeReplayStart,
    ...tag
  });

  if (includeOutput) {
    if (replay.gap) {
      send(ws, { type: 'gap', oldestAvailableSeq: replay.oldest, currentSeq: replay.current, ...tag });
    }
    for (const ev of replay.events) {
      send(ws, { type: 'output', seq: ev.seq, data: ev.data, ...tag });
    }
  }
  for (let i = localStart; i < len; i++) {
    send(ws, { type: 'claudeEvent', event: session.claudeEventLog[i]!, ...tag });
  }

  // Already exited: deliver the terminal state and skip live wiring.
  if (session.exited) {
    send(ws, {
      type: 'exit',
      code: session.exitCode,
      signal: session.exitSignal,
      seq: session.exitSeq ?? replay.current,
      ...tag
    });
    opts.onExited?.();
    return null;
  }

  const onOutput = (ev: OutputEvent): void => {
    send(ws, { type: 'output', seq: ev.seq, data: ev.data, ...tag });
  };
  const onExit = (info: { code: number | null; signal: string | null; seq: number }): void => {
    send(ws, { type: 'exit', code: info.code, signal: info.signal, seq: info.seq, ...tag });
    opts.onExited?.();
  };
  const onClaudeEvent = (ev: ClaudeSessionEvent): void => {
    send(ws, { type: 'claudeEvent', event: ev, ...tag });
  };
  if (includeOutput) session.emitter.on('output', onOutput);
  session.emitter.on('exit', onExit);
  session.emitter.on('claudeEvent', onClaudeEvent);

  return () => {
    if (includeOutput) session.emitter.off('output', onOutput);
    session.emitter.off('exit', onExit);
    session.emitter.off('claudeEvent', onClaudeEvent);
  };
}

// Clamp client-requested PTY dimensions. Last-resize-wins across clients:
// the most recently active viewport dictates the PTY size; the TUI
// redraws at the new size automatically.
function clampedResize(sessionId: string, cols: number, rows: number): void {
  resize(sessionId, Math.max(40, Math.min(500, cols | 0)), Math.max(10, Math.min(200, rows | 0)));
}

// Multiplexed mode (`/ws?mux=1`): one socket, many sessions (tmux-style).
// The client attaches/detaches sessions with tagged frames; every
// server→client message carries sessionId. N sessions cost ONE connection
// — the per-session-socket shape fell over once orchestrators pushed the
// session count past ~50 (dozens of parallel sockets, reconnect herds).
function handleMuxConnection(ws: WebSocket): void {
  const attached = new Map<string, () => void>(); // sessionId → detach

  const detach = (sessionId: string): void => {
    const d = attached.get(sessionId);
    if (d) d();
    attached.delete(sessionId);
  };

  ws.on('message', (raw) => {
    let parsed: ClientMsg | null = null;
    try {
      parsed = JSON.parse(raw.toString()) as ClientMsg;
    } catch {
      return; // mux mode is JSON-only; raw bytes have no session routing
    }
    if (parsed.type === 'attach') {
      const id = parsed.sessionId;
      if (!id || attached.has(id)) return;
      const session = getSession(id);
      if (!session) {
        send(ws, { type: 'error', message: `unknown session ${id}`, sessionId: id });
        return;
      }
      const det = attachSessionStream(ws, session, {
        lastSeq: Math.max(0, (parsed.lastSeq ?? 0) | 0),
        claudeEventsSince: Math.max(0, (parsed.claudeEventsSince ?? 0) | 0),
        tagSessionId: id,
        includeOutput: parsed.outputReplay !== false,
        // On PTY exit only this session detaches — the socket stays up
        // for every other attached session.
        onExited: () => detach(id)
      });
      if (det) attached.set(id, det);
      return;
    }
    if (parsed.type === 'detach') {
      if (parsed.sessionId) detach(parsed.sessionId);
      return;
    }
    if (parsed.type === 'input') {
      if (parsed.sessionId) writeInput(parsed.sessionId, parsed.data);
      return;
    }
    if (parsed.type === 'resize') {
      if (parsed.sessionId) clampedResize(parsed.sessionId, parsed.cols, parsed.rows);
      return;
    }
  });

  ws.on('close', () => {
    for (const d of attached.values()) d();
    attached.clear();
  });
}

// Single-session mode (`/ws?sessionId=…`): the original protocol. Still
// used by the CLI (`pretty attach`, `pretty tail -f`) and any client
// that hasn't moved to mux.
function handleSingleConnection(ws: WebSocket, url: URL, sessionId: string): void {
  const session = getSession(sessionId);
  if (!session) {
    send(ws, { type: 'error', message: `unknown session ${sessionId}` });
    ws.close(1008, 'unknown session');
    return;
  }

  const lastSeqParam = url.searchParams.get('lastSeq');
  const lastSeq = lastSeqParam ? Math.max(0, Number(lastSeqParam) | 0) : 0;
  const claudeSinceParam = url.searchParams.get('claudeEventsSince');
  const claudeEventsSince = claudeSinceParam ? Math.max(0, Number(claudeSinceParam) | 0) : 0;

  const detach = attachSessionStream(ws, session, {
    lastSeq,
    claudeEventsSince,
    onExited: () => ws.close(1000, 'pty exited')
  });
  if (!detach) return; // already exited; terminal state sent + socket closed

  ws.on('message', (raw, isBinary) => {
    if (isBinary) {
      writeInput(sessionId, (raw as Buffer).toString('utf8'));
      return;
    }
    const text = raw.toString();
    let parsed: ClientMsg | null = null;
    try {
      parsed = JSON.parse(text) as ClientMsg;
    } catch {
      writeInput(sessionId, text);
      return;
    }
    if (parsed.type === 'input') {
      writeInput(sessionId, parsed.data);
    } else if (parsed.type === 'resize') {
      clampedResize(sessionId, parsed.cols, parsed.rows);
    }
  });

  ws.on('close', () => {
    detach();
  });
}

wss.on('connection', (ws, req) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  if (url.searchParams.get('mux') === '1') {
    handleMuxConnection(ws);
    return;
  }
  const sessionId = url.searchParams.get('sessionId');
  if (!sessionId) {
    send(ws, { type: 'error', message: 'missing sessionId' });
    ws.close(1008, 'missing sessionId');
    return;
  }
  handleSingleConnection(ws, url, sessionId);
});

export function handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
  const url = new URL(req.url ?? '/', 'http://localhost');
  if (url.pathname !== '/ws') {
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit('connection', ws, req);
  });
}
