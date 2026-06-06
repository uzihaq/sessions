import type { CreateSessionRequest, SessionInfo, DirectoryCandidate } from '../types';
import { getActiveServer, isLocalServer } from '../lib/servers';
import { isTauri } from '../lib/tauriBridge';

// All REST/WS calls resolve their base URL through the active server at
// call time. Switching servers in the dropdown changes what subsequent
// fetches/WebSockets target without any other plumbing.
//
// Two modes:
//   • Browser + the default "This machine" server entry — return an
//     empty base so calls become relative URLs ("/api/...") and the
//     page-serving Vite handles the proxy to whatever PRETTYD_HOST
//     it was started with. This keeps the Tailscale browser flow
//     working: load http://<tailnet-ip>:5273/, Vite proxies to
//     localhost:8787 on the same machine, prettyd stays loopback-only.
//   • Tauri (no Vite proxy) OR a non-local server entry (e.g. the
//     Mac Mini from a MacBook Tauri install) — return an absolute URL
//     pointing at the configured host. CORS on prettyd is wildcarded
//     so cross-origin works.
function httpBase(): string {
  const s = getActiveServer();
  if (!isTauri() && isLocalServer(s)) return '';
  return `http://${s.host}:${s.port}`;
}

function wsBase(): string {
  const s = getActiveServer();
  if (!isTauri() && isLocalServer(s)) {
    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${proto}//${window.location.host}`;
  }
  return `ws://${s.host}:${s.port}`;
}

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`prettyd ${res.status}: ${text || res.statusText}`);
  }
  return res.json() as Promise<T>;
}

export async function listSessions(): Promise<SessionInfo[]> {
  const r = await fetch(`${httpBase()}/api/sessions`);
  const body = await json<{ sessions: SessionInfo[] }>(r);
  return body.sessions;
}

export async function createSession(req: CreateSessionRequest): Promise<SessionInfo> {
  const r = await fetch(`${httpBase()}/api/sessions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(req)
  });
  return json<SessionInfo>(r);
}

export interface Snapshot {
  text: string;
  // Server seq# the snapshot represents. Pass this to wsUrl as
  // lastSeq so the WS skips the replay of frames already painted
  // into the snapshot — the difference between "buffer fills top
  // to bottom over 3-5s" and "buffer is just there".
  seq: number;
}

// Fetch the runner's current xterm-headless snapshot (ANSI-coded text).
// Used by usePrettyParser instead of serializing the LOCAL browser xterm,
// because the local one wraps to viewport width while the runner stays
// at the PTY's fixed cols. This means Pretty view is consistent across
// clients of any size — phone, mac, agent — they all see the same
// canonical snapshot the runner has.
//
// `cols`: when set, prettyd reflows the snapshot ANSI-aware to that
// visible width before sending. The Reflowed view passes its viewport
// width here so long prose wraps to fit without horizontal scroll while
// box-drawing / table lines stay intact.
export async function snapshot(sessionId: string, cols?: number): Promise<Snapshot | null> {
  const params = cols && cols > 0 ? `?cols=${cols | 0}` : '';
  const r = await fetch(`${httpBase()}/api/sessions/${encodeURIComponent(sessionId)}/snapshot${params}`);
  if (r.status === 404) return null;
  if (!r.ok) {
    const text = await r.text().catch(() => '');
    throw new Error(`prettyd snapshot ${r.status}: ${text || r.statusText}`);
  }
  const text = await r.text();
  const seq = Number(r.headers.get('X-Pretty-Seq') ?? '0') || 0;
  return { text, seq };
}

export interface EventsResponse {
  events: import('../types').ClaudeSessionEvent[];
  nextIndex: number;
  totalCount: number;
}

// Fetch Claude JSONL events for a session, with optional windowing.
//
//   tail: only return the last N events (cheap chat preview)
//   since: return events from server-side log index N onwards
//          (incremental polling — pass previous nextIndex to fetch
//          only what's new since last time)
//
// Without params: returns the full ring buffer. Avoid this — live
// sessions hold ~15-20 MB of JSONL in memory. Every response carries
// nextIndex so the caller can resume from there.
export async function fetchClaudeEvents(
  sessionId: string,
  opts?: { tail?: number; since?: number }
): Promise<EventsResponse | null> {
  const params = new URLSearchParams();
  if (opts?.tail != null) params.set('tail', String(opts.tail));
  if (opts?.since != null) params.set('since', String(opts.since));
  const qs = params.toString();
  const url = `${httpBase()}/api/sessions/${encodeURIComponent(sessionId)}/events${qs ? '?' + qs : ''}`;
  const r = await fetch(url);
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`prettyd events ${r.status}`);
  return json<EventsResponse>(r);
}

// Resumable Claude session metadata. Scanned from ~/.claude/projects/*
// server-side. Powers the resume picker in New Session.
export interface ResumableSession {
  sessionId: string;
  cwd: string;
  modifiedAt: number;
  firstUserMessage: string;
  sizeBytes: number;
}
export async function fetchResumableSessions(): Promise<ResumableSession[]> {
  const r = await fetch(`${httpBase()}/api/claude-sessions`);
  const body = await json<{ sessions: ResumableSession[] }>(r);
  return body.sessions;
}

export async function listDirectories(): Promise<DirectoryCandidate[]> {
  const r = await fetch(`${httpBase()}/api/directories`);
  const body = await json<{ directories: DirectoryCandidate[] }>(r);
  return body.directories;
}

export interface FsEntry {
  name: string;
  kind: 'dir' | 'file' | 'symlink' | 'other';
  hidden: boolean;
}
export interface FsListing {
  path: string;       // canonical absolute path
  parent: string | null; // null when at filesystem root
  entries: FsEntry[];
}

// Direct filesystem listing — the DirectoryBrowser walks this. No
// curation, no "project-shape" filtering; every child the prettyd
// process can stat shows up. Default to $HOME when path is omitted.
export async function listFs(path?: string): Promise<FsListing> {
  // httpBase() returns '' for the local server (browser + Vite proxy
  // path), so the relative URL needs a base for new URL() to accept.
  // Browser uses window.location.origin; Tauri uses the absolute base.
  const base = httpBase() || window.location.origin;
  const url = new URL(`${base}/api/fs/list`);
  if (path) url.searchParams.set('path', path);
  const r = await fetch(url);
  return json<FsListing>(r);
}

export async function killSession(id: string): Promise<void> {
  const r = await fetch(`${httpBase()}/api/sessions/${encodeURIComponent(id)}`, { method: 'DELETE' });
  await json<{ ok: boolean }>(r);
}

// Push raw bytes to a session's PTY. Used by GridCell's keystroke
// forwarding — no per-cell WebSocket, just a single HTTP POST per
// keystroke. The 2-second poll on each cell already reflects the
// result back into the reflowed thumbnail.
export async function sendInput(sessionId: string, data: string): Promise<void> {
  const r = await fetch(`${httpBase()}/api/sessions/${encodeURIComponent(sessionId)}/input`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ data })
  });
  await json<{ ok: boolean }>(r);
}

// Upload a file to the prettyd host's uploads dir. Returns the absolute
// path on the server. Matches the macOS Terminal drag-drop convention
// — the InputBar pastes that path as text after a successful upload so
// Claude/Codex can read the file off disk.
export async function uploadFile(sessionId: string, file: File): Promise<{ path: string; size: number }> {
  const r = await fetch(`${httpBase()}/api/sessions/${encodeURIComponent(sessionId)}/upload`, {
    method: 'POST',
    headers: {
      'content-type': file.type || 'application/octet-stream',
      'x-pretty-filename': file.name || 'file'
    },
    body: file
  });
  return json<{ path: string; size: number }>(r);
}

export function wsUrl(sessionId: string, lastSeq?: number, claudeEventsSince?: number): string {
  const params = new URLSearchParams({ sessionId });
  if (lastSeq && lastSeq > 0) params.set('lastSeq', String(lastSeq));
  if (claudeEventsSince && claudeEventsSince > 0) {
    params.set('claudeEventsSince', String(claudeEventsSince));
  }
  return `${wsBase()}/ws?${params.toString()}`;
}
