import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type WebSocket } from 'ws';
import { getSession, writeInput, resize, type OutputEvent } from './sessions.js';
import type { ClaudeSessionEvent } from './sessionFileWatcher.js';
import { PROTOCOL_VERSION, type ClientMsg, type ServerMsg } from './types.js';

const wss = new WebSocketServer({ noServer: true });

function send(ws: WebSocket, msg: ServerMsg): void {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
}

wss.on('connection', (ws, req) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const sessionId = url.searchParams.get('sessionId');
  if (!sessionId) {
    send(ws, { type: 'error', message: 'missing sessionId' });
    ws.close(1008, 'missing sessionId');
    return;
  }
  const session = getSession(sessionId);
  if (!session) {
    send(ws, { type: 'error', message: `unknown session ${sessionId}` });
    ws.close(1008, 'unknown session');
    return;
  }

  // Resume point. 0 (or absent) means "give me everything you still have".
  const lastSeqParam = url.searchParams.get('lastSeq');
  const lastSeq = lastSeqParam ? Math.max(0, Number(lastSeqParam) | 0) : 0;
  const replay = session.log.since(lastSeq);
  // Claude event resume point. Client passes the index it already
  // has, server skips events at indices < this. Without this, every
  // WS reconnect (phone lock, tab switch, etc.) replayed the full
  // 5000-event ring — for a long session that's tens of MB on the
  // wire and the same amount of React reducer work, all for events
  // the client already had. Default 0 keeps the original behavior
  // for callers that don't pass the param.
  const claudeSinceParam = url.searchParams.get('claudeEventsSince');
  const claudeEventsSince = claudeSinceParam
    ? Math.max(0, Number(claudeSinceParam) | 0)
    : 0;

  // Compute the claudeEvent replay window BEFORE sending hello — the
  // client uses claudeReplayStart to set its local counter so future
  // reconnect ?claudeEventsSince= calls align with the server index.
  //
  // On fresh connect (claudeEventsSince=0): cap initial replay at the
  // TAIL (last INITIAL_REPLAY_CAP events). Long sessions accumulate
  // thousands of events; the RemoteView renders ~50 anyway, and the
  // initial replay was the dominant cost of opening Pretty on a long
  // session (~15-20 MB and hundreds of ms of React work). Older
  // history is reachable via the HTTP /events endpoint on demand.
  //
  // On reconnect (claudeEventsSince>0): ship only the deltas.
  // Indices are ABSOLUTE (claudeEventBase + array index) so they survive
  // the 5000-cap front-trim. Map the client's absolute resume point into a
  // local array offset; clamp to 0 if the client is older than what we
  // still retain (it just gets the oldest-available onward, no duplicates).
  const INITIAL_REPLAY_CAP = 300;
  const base = session.claudeEventBase;
  const len = session.claudeEventLog.length;
  const claudeEventsCount = base + len; // absolute total ever seen
  const localStart = claudeEventsSince > 0
    ? Math.max(0, Math.min(claudeEventsSince - base, len))
    : Math.max(0, len - INITIAL_REPLAY_CAP);
  const claudeReplayStart = base + localStart; // absolute, for the client's counter

  send(ws, {
    type: 'hello',
    protocol: PROTOCOL_VERSION,
    session: session.info,
    currentSeq: replay.current,
    resumedFromSeq: lastSeqParam ? lastSeq : null,
    claudeEventsCount,
    claudeReplayStart
  });

  if (replay.gap) {
    send(ws, {
      type: 'gap',
      oldestAvailableSeq: replay.oldest,
      currentSeq: replay.current
    });
  }
  for (const ev of replay.events) {
    send(ws, { type: 'output', seq: ev.seq, data: ev.data });
  }

  // Replay the windowed slice computed above (initial-tail OR
  // since-deltas). Sent after raw-byte replay so the client updates
  // its terminal first, then layers structured events on top.
  for (let i = localStart; i < len; i++) {
    send(ws, { type: 'claudeEvent', event: session.claudeEventLog[i]! });
  }

  // If the session already exited before this client connected, push the
  // exit event after the replay so the client lands in the same terminal
  // state as if it had been there the whole time, then close the socket.
  if (session.exited) {
    send(ws, {
      type: 'exit',
      code: session.exitCode,
      signal: session.exitSignal,
      seq: session.exitSeq ?? replay.current
    });
    ws.close(1000, 'pty exited');
    return;
  }

  const onOutput = (ev: OutputEvent): void => {
    send(ws, { type: 'output', seq: ev.seq, data: ev.data });
  };
  const onExit = (info: { code: number | null; signal: string | null; seq: number }): void => {
    send(ws, { type: 'exit', code: info.code, signal: info.signal, seq: info.seq });
    ws.close(1000, 'pty exited');
  };
  const onClaudeEvent = (ev: ClaudeSessionEvent): void => {
    send(ws, { type: 'claudeEvent', event: ev });
  };
  session.emitter.on('output', onOutput);
  session.emitter.on('exit', onExit);
  session.emitter.on('claudeEvent', onClaudeEvent);

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
      // Last-resize-wins: the most recently active client's viewport
      // dictates the PTY size. The TUI (Claude / Codex / etc.) redraws
      // at the new size automatically. If two clients are active at
      // different sizes they'll fight, but the user explicitly chose
      // this trade — previously the PTY stayed locked to its create-
      // time size and every client had to CSS-zoom xterm visually,
      // which felt cramped on big screens. Reasonable bounds clamp
      // applied so a misbehaving client can't shrink the PTY to
      // unusable dimensions.
      const cols = Math.max(40, Math.min(500, parsed.cols | 0));
      const rows = Math.max(10, Math.min(200, parsed.rows | 0));
      resize(sessionId, cols, rows);
    }
  });

  ws.on('close', () => {
    session.emitter.off('output', onOutput);
    session.emitter.off('exit', onExit);
    session.emitter.off('claudeEvent', onClaudeEvent);
  });
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
