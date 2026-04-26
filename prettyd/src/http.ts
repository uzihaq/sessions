import type { IncomingMessage, ServerResponse } from 'node:http';
import { createSession, killSession, listSessions } from './sessions.js';
import type { CreateSessionRequest } from './types.js';

function send(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  // Phase 1 prototype: localhost only, allow Vite dev origin.
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'content-type');
  res.end(JSON.stringify(body));
}

async function readJson<T>(req: IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw) return {} as T;
  return JSON.parse(raw) as T;
}

export async function handleHttp(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const path = url.pathname;
  const method = req.method ?? 'GET';

  if (method === 'OPTIONS') {
    send(res, 204, {});
    return;
  }

  if (path === '/api/health' && method === 'GET') {
    send(res, 200, { ok: true, name: 'prettyd', version: '0.1.0' });
    return;
  }

  if (path === '/api/sessions' && method === 'GET') {
    send(res, 200, { sessions: listSessions() });
    return;
  }

  if (path === '/api/sessions' && method === 'POST') {
    try {
      const body = await readJson<CreateSessionRequest>(req);
      const info = createSession(body);
      send(res, 201, info);
    } catch (err) {
      send(res, 400, { error: (err as Error).message });
    }
    return;
  }

  // /api/sessions/:id
  const match = /^\/api\/sessions\/([^/]+)$/.exec(path);
  if (match && method === 'DELETE') {
    const id = match[1]!;
    const ok = killSession(id);
    send(res, ok ? 200 : 404, { ok });
    return;
  }

  send(res, 404, { error: 'not found', path });
}
