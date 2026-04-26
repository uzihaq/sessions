import type { CreateSessionRequest, SessionInfo } from '../types';

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`prettyd ${res.status}: ${text || res.statusText}`);
  }
  return res.json() as Promise<T>;
}

export async function listSessions(): Promise<SessionInfo[]> {
  const r = await fetch('/api/sessions');
  const body = await json<{ sessions: SessionInfo[] }>(r);
  return body.sessions;
}

export async function createSession(req: CreateSessionRequest): Promise<SessionInfo> {
  const r = await fetch('/api/sessions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(req)
  });
  return json<SessionInfo>(r);
}

export async function killSession(id: string): Promise<void> {
  const r = await fetch(`/api/sessions/${encodeURIComponent(id)}`, { method: 'DELETE' });
  await json<{ ok: boolean }>(r);
}

export function wsUrl(sessionId: string, lastSeq?: number): string {
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const base = `${proto}//${window.location.host}/ws?sessionId=${encodeURIComponent(sessionId)}`;
  return lastSeq && lastSeq > 0 ? `${base}&lastSeq=${lastSeq}` : base;
}
