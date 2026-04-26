import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type WebSocket } from 'ws';
import { getSession, resize, writeInput, type OutputEvent } from './sessions.js';
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

  send(ws, {
    type: 'hello',
    protocol: PROTOCOL_VERSION,
    session: session.info,
    currentSeq: replay.current,
    resumedFromSeq: lastSeqParam ? lastSeq : null
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
  session.emitter.on('output', onOutput);
  session.emitter.on('exit', onExit);

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
      resize(sessionId, parsed.cols, parsed.rows);
    }
  });

  ws.on('close', () => {
    session.emitter.off('output', onOutput);
    session.emitter.off('exit', onExit);
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
