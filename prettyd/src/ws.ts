import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type WebSocket } from 'ws';
import { getSession, resize, writeInput } from './sessions.js';
import type { ClientMsg, ServerMsg } from './types.js';

const wss = new WebSocketServer({ noServer: true });

function sendJson(ws: WebSocket, msg: ServerMsg): void {
  ws.send(JSON.stringify(msg));
}

wss.on('connection', (ws, req) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const sessionId = url.searchParams.get('sessionId');
  if (!sessionId) {
    sendJson(ws, { type: 'error', message: 'missing sessionId' });
    ws.close(1008, 'missing sessionId');
    return;
  }
  const session = getSession(sessionId);
  if (!session) {
    sendJson(ws, { type: 'error', message: `unknown session ${sessionId}` });
    ws.close(1008, 'unknown session');
    return;
  }

  sendJson(ws, { type: 'hello', session: session.info });

  // Phase 1: stream PTY output as raw text frames so xterm.js can write
  // them straight in. JSON is reserved for control messages (hello/exit).
  // Phase 2 will replace this with a sequenced framed protocol.
  const onData = (data: string): void => {
    if (ws.readyState === ws.OPEN) ws.send(data);
  };
  const onExit = ({ code, signal }: { code: number | null; signal: string | null }): void => {
    sendJson(ws, { type: 'exit', code, signal });
    ws.close(1000, 'pty exited');
  };
  session.emitter.on('data', onData);
  session.emitter.on('exit', onExit);

  ws.on('message', (raw, isBinary) => {
    // Input is text-only in Phase 1 (xterm.js onData → string).
    // Control frames are JSON; data frames are raw input as plain text.
    if (isBinary) {
      writeInput(sessionId, (raw as Buffer).toString('utf8'));
      return;
    }
    const text = raw.toString();
    let parsed: ClientMsg | null = null;
    try {
      parsed = JSON.parse(text) as ClientMsg;
    } catch {
      // Not JSON → treat as raw input passthrough.
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
    session.emitter.off('data', onData);
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
