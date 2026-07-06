import type { CreateSessionRequest, SessionInfo, DirectoryCandidate } from '../types';
import { getActiveServer, isLocalServer } from '../lib/servers';
import { isTauri } from '../lib/tauriBridge';

// Thrown when the daemon returns HTTP 401 (token required / wrong token).
// Callers (UI components) can instanceof-check this to show an auth prompt
// rather than a generic error toast.  The `.code` property lets non-class
// checks work too: `err.code === 'auth'`.
export class AuthError extends Error {
  readonly code = 'auth' as const;
  constructor() {
    super('prettyd: authentication required — check your server token (401)');
    this.name = 'AuthError';
  }
}

// All REST/WS calls resolve their base URL through the active server at
// call time. Switching servers in the dropdown changes what subsequent
// fetches/WebSockets target without any other plumbing.
//
// Two modes:
//   • Browser + the default "This machine" server entry — talk DIRECTLY
//     to prettyd on the same host the page was loaded from
//     (http://<page-hostname>:<prettyd-port>). The page and prettyd live
//     on the same machine, so whatever address reached Vite (Tailscale
//     IP, LAN IP) also reaches prettyd. We used to return '' here and
//     let Vite's dev proxy forward — but the proxy is a single Node
//     process that wedges under dozens of long-lived WebSockets: it
//     held ~73 half-dead upstream legs while the daemon had moved on,
//     and typing went into those zombie sockets ("can't type"). CORS on
//     prettyd is wildcarded, so the direct cross-port call just works.
//   • Tauri OR a non-local server entry (e.g. the Mac Mini from a
//     MacBook Tauri install) — absolute URL from the configured host.
function useSameOriginDaemon(s: ReturnType<typeof getActiveServer>): boolean {
  return !isTauri() && isLocalServer(s) && !import.meta.env.DEV;
}

function httpBase(): string {
  const s = getActiveServer();
  if (useSameOriginDaemon(s)) {
    return window.location.origin;
  }
  // Honour an explicit scheme (e.g. 'https' for remote servers behind TLS
  // termination); fall back to 'http' so existing stored configs work.
  const scheme = s.scheme ?? 'http';
  if (!isTauri() && isLocalServer(s)) {
    return `${scheme}://${window.location.hostname}:${s.port}`;
  }
  return `${scheme}://${s.host}:${s.port}`;
}

function wsBase(): string {
  const s = getActiveServer();
  if (useSameOriginDaemon(s)) {
    const scheme = window.location.protocol === 'https:' ? 'wss' : 'ws';
    return `${scheme}://${window.location.host}`;
  }
  // Mirror the http→https / ws→wss mapping so TLS connections work end-to-end.
  const scheme = s.scheme === 'https' ? 'wss' : 'ws';
  if (!isTauri() && isLocalServer(s)) {
    return `${scheme}://${window.location.hostname}:${s.port}`;
  }
  return `${scheme}://${s.host}:${s.port}`;
}

// Returns `{ Authorization: 'Bearer <token>' }` when the active server has a
// token configured, or an empty object when open (no auth).
function authHeaders(): Record<string, string> {
  const s = getActiveServer();
  return s.token ? { Authorization: `Bearer ${s.token}` } : {};
}

// Drop-in replacement for the raw `fetch()` calls below.  Injects auth
// headers from the active server config and translates a 401 response into
// an AuthError so the UI can prompt for a token instead of showing a
// generic "prettyd 401" error.
async function apiFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const extra = authHeaders();
  const merged: RequestInit = {
    ...init,
    headers: { ...extra, ...(init?.headers as Record<string, string> | undefined) }
  };
  const res = await fetch(input, merged);
  if (res.status === 401) throw new AuthError();
  return res;
}

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`prettyd ${res.status}: ${text || res.statusText}`);
  }
  return res.json() as Promise<T>;
}

export async function listSessions(): Promise<SessionInfo[]> {
  const r = await apiFetch(`${httpBase()}/api/sessions`);
  const body = await json<{ sessions: SessionInfo[] }>(r);
  return body.sessions;
}

export async function createSession(req: CreateSessionRequest): Promise<SessionInfo> {
  const r = await apiFetch(`${httpBase()}/api/sessions`, {
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
  const r = await apiFetch(`${httpBase()}/api/sessions/${encodeURIComponent(sessionId)}/snapshot${params}`);
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
  startIndex: number;
  endIndex: number;
}

// Fetch Claude JSONL events for a session, with optional windowing.
//
//   tail: only return the last N events in the selected window
//   since: return events from server-side log index N onwards
//          (incremental polling — pass previous nextIndex to fetch
//          only what's new since last time)
//   before: end the selected window before absolute index N
//
// Without params: returns the full ring buffer. Avoid this — live
// sessions hold ~15-20 MB of JSONL in memory. Every response carries
// nextIndex so the caller can resume from there.
export async function fetchClaudeEvents(
  sessionId: string,
  opts?: { tail?: number; since?: number; before?: number }
): Promise<EventsResponse | null> {
  const params = new URLSearchParams();
  if (opts?.tail != null) params.set('tail', String(opts.tail));
  if (opts?.since != null) params.set('since', String(opts.since));
  if (opts?.before != null) params.set('before', String(opts.before));
  const qs = params.toString();
  const url = `${httpBase()}/api/sessions/${encodeURIComponent(sessionId)}/events${qs ? '?' + qs : ''}`;
  const r = await apiFetch(url);
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
  const r = await apiFetch(`${httpBase()}/api/claude-sessions`);
  const body = await json<{ sessions: ResumableSession[] }>(r);
  return body.sessions;
}

export async function listDirectories(): Promise<DirectoryCandidate[]> {
  const r = await apiFetch(`${httpBase()}/api/directories`);
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
  // httpBase() now always returns an absolute URL (scheme://host:port),
  // so we can use it directly with new URL().
  const base = httpBase() || window.location.origin;
  const url = new URL(`${base}/api/fs/list`);
  if (path) url.searchParams.set('path', path);
  const r = await apiFetch(url);
  return json<FsListing>(r);
}

export async function killSession(id: string): Promise<void> {
  const r = await apiFetch(`${httpBase()}/api/sessions/${encodeURIComponent(id)}`, { method: 'DELETE' });
  await json<{ ok: boolean }>(r);
}

// Push raw bytes to a session's PTY. Used by GridCell's keystroke
// forwarding — no per-cell WebSocket, just a single HTTP POST per
// keystroke. The 2-second poll on each cell already reflects the
// result back into the reflowed thumbnail.
export async function sendInput(sessionId: string, data: string): Promise<void> {
  const r = await apiFetch(`${httpBase()}/api/sessions/${encodeURIComponent(sessionId)}/input`, {
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
  const r = await apiFetch(`${httpBase()}/api/sessions/${encodeURIComponent(sessionId)}/upload`, {
    method: 'POST',
    headers: {
      'content-type': file.type || 'application/octet-stream',
      'x-pretty-filename': file.name || 'file'
    },
    body: file
  });
  return json<{ path: string; size: number }>(r);
}

export interface PushSubscriptionPayload {
  endpoint: string;
  expirationTime?: number | null;
  keys: {
    p256dh: string;
    auth: string;
  };
}

function pushSubscriptionPayload(subscription: PushSubscription): PushSubscriptionPayload {
  const raw = subscription.toJSON();
  if (
    typeof raw.endpoint !== 'string' ||
    !raw.keys ||
    typeof raw.keys.p256dh !== 'string' ||
    typeof raw.keys.auth !== 'string'
  ) {
    throw new Error('browser returned an invalid push subscription');
  }
  return {
    endpoint: raw.endpoint,
    expirationTime: raw.expirationTime,
    keys: {
      p256dh: raw.keys.p256dh,
      auth: raw.keys.auth
    }
  };
}

export async function getPushVapidPublicKey(): Promise<string> {
  const r = await apiFetch(`${httpBase()}/api/push/vapid`);
  const body = await json<{ publicKey: string }>(r);
  return body.publicKey;
}

export async function subscribePush(subscription: PushSubscription): Promise<void> {
  const r = await apiFetch(`${httpBase()}/api/push/subscribe`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(pushSubscriptionPayload(subscription))
  });
  await json<{ ok: boolean }>(r);
}

export async function unsubscribePush(endpoint: string): Promise<void> {
  const r = await apiFetch(`${httpBase()}/api/push/unsubscribe`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ endpoint })
  });
  await json<{ ok: boolean }>(r);
}

export function wsUrl(sessionId: string, lastSeq?: number, claudeEventsSince?: number): string {
  const s = getActiveServer();
  const params = new URLSearchParams({ sessionId });
  if (lastSeq && lastSeq > 0) params.set('lastSeq', String(lastSeq));
  if (claudeEventsSince && claudeEventsSince > 0) {
    params.set('claudeEventsSince', String(claudeEventsSince));
  }
  // Browsers cannot set custom headers on WebSocket — token goes in URL instead.
  if (s.token) params.set('token', s.token);
  return `${wsBase()}/ws?${params.toString()}`;
}

// Multiplexed WS endpoint: ONE socket per window carrying every attached
// session's traffic as sessionId-tagged frames (tmux-style). useTerminal
// attaches/detaches sessions over it via lib/wsMux.
export function wsMuxUrl(): string {
  const s = getActiveServer();
  // Browsers cannot set WS request headers — pass the auth token as a query
  // param instead (daemon accepts ?token=<hex> per contract #1).
  const params = new URLSearchParams({ mux: '1' });
  if (s.token) params.set('token', s.token);
  return `${wsBase()}/ws?${params.toString()}`;
}
