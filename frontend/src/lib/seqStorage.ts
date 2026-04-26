// Persists the last-seen seq# per session so that a full browser refresh
// (or a phone unlock that drops the WS) can resume from where we left off.
//
// Storage is best-effort: if localStorage is full, throws, or is denied
// (private mode), we silently fall back to in-memory only.

const KEY_PREFIX = 'pretty-pty:lastSeq:';

const memCache = new Map<string, number>();

export function readLastSeq(sessionId: string): number {
  const cached = memCache.get(sessionId);
  if (cached !== undefined) return cached;
  try {
    const raw = window.localStorage.getItem(KEY_PREFIX + sessionId);
    if (raw === null) return 0;
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? n : 0;
  } catch {
    return 0;
  }
}

export function writeLastSeq(sessionId: string, seq: number): void {
  memCache.set(sessionId, seq);
  try {
    window.localStorage.setItem(KEY_PREFIX + sessionId, String(seq));
  } catch {
    // quota exceeded or storage disabled — memCache is enough for the
    // current page session
  }
}

export function clearLastSeq(sessionId: string): void {
  memCache.delete(sessionId);
  try {
    window.localStorage.removeItem(KEY_PREFIX + sessionId);
  } catch {
    // ignore
  }
}
