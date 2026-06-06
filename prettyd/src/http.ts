import type { IncomingMessage, ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import nodePath from 'node:path';
import { createSession, getSession, killSession, listSessions, snapshot, writeInput } from './sessions.js';
import { scanResumableSessions } from './claudeSessionScanner.js';
import { listDirectoryCandidates } from './directories.js';
import type { CreateSessionRequest } from './types.js';

function send(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  // prettyd is loopback-only by default. Vite proxies browser traffic to it.
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
    const includeExited = url.searchParams.get('include_exited') === '1';
    send(res, 200, { sessions: listSessions({ includeExited }) });
    return;
  }

  if (path === '/api/directories' && method === 'GET') {
    send(res, 200, { directories: listDirectoryCandidates() });
    return;
  }

  // /api/fs/list?path=<abs> — direct directory listing for the cwd
  // picker. No "project shape" smart-filtering: every immediate child
  // of the requested path that we can stat shows up. Default path is
  // $HOME. Returned entries are sorted: dirs first, alphabetical.
  if (path === '/api/fs/list' && method === 'GET') {
    let p = url.searchParams.get('path') ?? os.homedir();
    if (!nodePath.isAbsolute(p)) {
      send(res, 400, { error: 'path must be absolute' });
      return;
    }
    try {
      // Resolve symlinks + ".." so the returned canonical path is a
      // real, navigable absolute (avoids "/x/../y" living in the URL).
      let canonical: string;
      try { canonical = fs.realpathSync(p); }
      catch { canonical = nodePath.resolve(p); }
      const st = fs.statSync(canonical);
      if (!st.isDirectory()) {
        send(res, 400, { error: 'not a directory', path: canonical });
        return;
      }
      const names = fs.readdirSync(canonical);
      const entries = names.map((name) => {
        const full = nodePath.join(canonical, name);
        let kind: 'dir' | 'file' | 'symlink' | 'other' = 'other';
        try {
          const lst = fs.lstatSync(full);
          if (lst.isSymbolicLink()) {
            // Resolve symlink target's kind so the user can click into
            // a symlink-to-dir as if it were a real directory.
            try {
              const tst = fs.statSync(full);
              kind = tst.isDirectory() ? 'dir' : (tst.isFile() ? 'file' : 'other');
            } catch { kind = 'symlink'; }
          } else if (lst.isDirectory()) kind = 'dir';
          else if (lst.isFile()) kind = 'file';
        } catch { /* unreadable — keep kind 'other' */ }
        return { name, kind, hidden: name.startsWith('.') };
      });
      entries.sort((a, b) => {
        if ((a.kind === 'dir') !== (b.kind === 'dir')) return a.kind === 'dir' ? -1 : 1;
        return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
      });
      const parent = canonical === '/' ? null : nodePath.dirname(canonical);
      send(res, 200, { path: canonical, parent, entries });
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      const code = e.code === 'ENOENT' ? 404 : e.code === 'EACCES' ? 403 : 500;
      send(res, code, { error: e.message, code: e.code });
    }
    return;
  }

  if (path === '/api/sessions' && method === 'POST') {
    try {
      const body = await readJson<CreateSessionRequest>(req);
      const info = await createSession(body);
      send(res, 201, info);
    } catch (err) {
      send(res, 400, { error: (err as Error).message });
    }
    return;
  }

  // /api/sessions/:id
  const idMatch = /^\/api\/sessions\/([^/]+)$/.exec(path);
  if (idMatch && method === 'DELETE') {
    const id = idMatch[1]!;
    const ok = killSession(id);
    send(res, ok ? 200 : 404, { ok });
    return;
  }

  // /api/sessions/:id/snapshot — current xterm-headless serialized buffer.
  // Used by the `pretty snap <id>` CLI and by the future inactive-tab
  // parser-icon detector. text/plain so curl|less prints something useful.
  //
  // Optional `?cols=N` triggers server-side ANSI-aware reflow to width N.
  // The browser ReflowedView passes its viewport width here so prose wraps
  // cleanly while the PTY itself stays at the wide canonical cols.
  const snapMatch = /^\/api\/sessions\/([^/]+)\/snapshot$/.exec(path);
  if (snapMatch && method === 'GET') {
    const id = snapMatch[1]!;
    const colsParam = url.searchParams.get('cols');
    const cols = colsParam ? Math.max(0, Number(colsParam) | 0) : 0;
    const result = await snapshot(id, cols > 0 ? { cols } : undefined);
    if (result === null) {
      send(res, 404, { error: 'unknown session', id });
      return;
    }
    res.statusCode = 200;
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Access-Control-Allow-Origin', '*');
    // Expose the seq this snapshot represents so the browser can
    // open a WebSocket with ?lastSeq=N and skip re-replaying
    // everything that's already painted into xterm.
    res.setHeader('Access-Control-Expose-Headers', 'X-Pretty-Seq');
    res.setHeader('X-Pretty-Seq', String(result.seq));
    res.end(result.text);
    return;
  }

  // /api/claude-sessions — list every Claude session this user has
  // on disk, grouped by cwd. Powers the "Resume a session" picker in
  // the New Session dialog. Sourced from ~/.claude/projects/*.
  if (path === '/api/claude-sessions' && method === 'GET') {
    const list = await scanResumableSessions();
    send(res, 200, { sessions: list });
    return;
  }

  // /api/sessions/:id/events — return Claude JSONL events.
  //
  // Query params for incremental / windowed access (any pair is fine):
  //   ?since=<n>   start at index n in the server-side log (incremental
  //                polling — client tracks the previous nextIndex and
  //                fetches only what it hasn't seen).
  //   ?tail=<n>    return only the last n events (cheap for chat
  //                previews; the GridView cells use tail=20).
  //
  // Default (no params) preserves the original behavior — returns the
  // entire log. The response always includes `nextIndex` so the client
  // can resume from there next time, and `totalCount` so it can size
  // an empty state correctly.
  //
  // Sizing context: live sessions hit 10-20 MB of JSONL events. The
  // GridView cells polling this every 2s with no params would blow
  // through a phone's CPU + bandwidth. With ?tail=20 they fetch ~50KB.
  const eventsMatch = /^\/api\/sessions\/([^/]+)\/events$/.exec(path);
  if (eventsMatch && method === 'GET') {
    const id = eventsMatch[1]!;
    const sess = getSession(id);
    if (!sess) {
      send(res, 404, { error: 'unknown session', id });
      return;
    }
    const log = sess.claudeEventLog;
    const total = log.length;
    const sinceRaw = url.searchParams.get('since');
    const tailRaw = url.searchParams.get('tail');
    let start = 0;
    if (sinceRaw != null) {
      const n = Number(sinceRaw);
      if (Number.isFinite(n) && n >= 0) start = Math.min(n, total);
    }
    if (tailRaw != null) {
      const n = Number(tailRaw);
      if (Number.isFinite(n) && n > 0) {
        const tailStart = Math.max(0, total - Math.floor(n));
        // tail wins over since if both passed — caller asked for "last n"
        if (sinceRaw == null) start = tailStart;
      }
    }
    const events = start === 0 ? log : log.slice(start);
    send(res, 200, { events, nextIndex: total, totalCount: total });
    return;
  }

  // /api/sessions/:id/input — POST { data: string } to send raw bytes.
  // Used by `pretty send` and `pretty keys`.
  const inputMatch = /^\/api\/sessions\/([^/]+)\/input$/.exec(path);
  if (inputMatch && method === 'POST') {
    const id = inputMatch[1]!;
    try {
      const body = await readJson<{ data: string }>(req);
      const ok = writeInput(id, body.data ?? '');
      send(res, ok ? 200 : 404, { ok });
    } catch (err) {
      send(res, 400, { error: (err as Error).message });
    }
    return;
  }

  // /api/sessions/:id/upload — POST raw file body (with X-Pretty-Filename
  // and Content-Type headers describing the file). Saves to a per-user
  // uploads dir and returns the absolute path. The frontend then types
  // that path into the InputBar so Claude/Codex can read the file off
  // disk — matches the macOS Terminal.app drag-drop convention where
  // dropping a file pastes its path.
  const uploadMatch = /^\/api\/sessions\/([^/]+)\/upload$/.exec(path);
  if (uploadMatch && method === 'POST') {
    const id = uploadMatch[1]!;
    if (!getSession(id)) {
      send(res, 404, { error: 'unknown session', id });
      return;
    }
    try {
      const filename = String(req.headers['x-pretty-filename'] ?? 'file');
      // Restrict to a safe basename — the header is user-controlled and
      // we never want a path-traversal that escapes the uploads dir.
      const safeBase = nodePath.basename(filename).replace(/[^\w.\- ]/g, '_').slice(0, 96);
      const ext = nodePath.extname(safeBase) || '';
      const stem = nodePath.basename(safeBase, ext) || 'file';
      const uploadsDir = nodePath.join(
        os.homedir(),
        '.local', 'state', 'pretty-PTY', 'uploads'
      );
      fs.mkdirSync(uploadsDir, { recursive: true, mode: 0o700 });
      const outName = `${stem}-${randomUUID().slice(0, 8)}${ext}`;
      const outPath = nodePath.join(uploadsDir, outName);
      const chunks: Buffer[] = [];
      let total = 0;
      // Cap at 25 MB so a runaway client can't fill the disk. Claude
      // doesn't usefully consume larger images anyway.
      const MAX = 25 * 1024 * 1024;
      for await (const chunk of req) {
        const buf = chunk as Buffer;
        total += buf.length;
        if (total > MAX) {
          send(res, 413, { error: 'file too large', max: MAX });
          return;
        }
        chunks.push(buf);
      }
      fs.writeFileSync(outPath, Buffer.concat(chunks), { mode: 0o600 });
      send(res, 200, { path: outPath, size: total });
    } catch (err) {
      send(res, 500, { error: (err as Error).message });
    }
    return;
  }

  send(res, 404, { error: 'not found', path });
}
