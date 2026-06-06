// User-chosen labels for session tabs. Two layers:
//
//   labelById[sessionId] — explicit rename for a specific prettyd
//     session. Overrides everything else.
//   labelByCwd[cwd]      — "friendly name for this project." Set
//     automatically every time the user renames a tab (we record
//     the cwd alongside the session id), so a fresh session or a
//     resume in the same folder inherits the same friendly name
//     without the user having to rename again. Also makes the
//     resume picker show your real project names instead of bare
//     folder basenames.
//
// Empty / missing override = fall back to the cwd-derived basename.

import { useSyncExternalStore } from 'react';

const STORAGE_KEY = 'pretty-pty:tab-labels:v2';

interface Stored {
  byId: Record<string, string>;
  byCwd: Record<string, string>;
}

function read(): Stored {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      // Migrate v1 single-map shape, if present.
      const legacy = window.localStorage.getItem('pretty-pty:tab-labels:v1');
      if (legacy) {
        const parsed = JSON.parse(legacy);
        if (parsed && typeof parsed === 'object') {
          const byId: Record<string, string> = {};
          for (const [k, v] of Object.entries(parsed)) {
            if (typeof k === 'string' && typeof v === 'string') byId[k] = v;
          }
          return { byId, byCwd: {} };
        }
      }
      return { byId: {}, byCwd: {} };
    }
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') {
      return {
        byId: (parsed.byId && typeof parsed.byId === 'object') ? parsed.byId : {},
        byCwd: (parsed.byCwd && typeof parsed.byCwd === 'object') ? parsed.byCwd : {}
      };
    }
  } catch { /* ignore */ }
  return { byId: {}, byCwd: {} };
}

function write(state: Stored): void {
  try { window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); }
  catch { /* quota / private mode — non-fatal */ }
}

let cache: Stored = read();
const subs = new Set<() => void>();
function notify(): void { for (const cb of subs) cb(); }

export function getTabLabel(sessionId: string): string | null {
  return cache.byId[sessionId] ?? null;
}

// Resolve label for a session, considering both id-specific AND cwd
// inheritance. The id override always wins; cwd is the fallback that
// makes new/resumed sessions feel like the same project.
export function resolveLabel(sessionId: string | null, cwd: string | null): string | null {
  if (sessionId && cache.byId[sessionId]) return cache.byId[sessionId];
  if (cwd && cache.byCwd[cwd]) return cache.byCwd[cwd];
  return null;
}

// Look up purely by cwd — used by the resume picker, where the
// "previous session" had a different id than what we'll spawn for the
// resume, but the cwd is the same.
export function getCwdLabel(cwd: string): string | null {
  return cache.byCwd[cwd] ?? null;
}

// Set the label for a specific prettyd session. Also records the cwd
// → label mapping so future sessions in the same folder inherit it.
export function setTabLabel(sessionId: string, label: string, cwd?: string): void {
  const trimmed = label.trim();
  const byId = { ...cache.byId };
  const byCwd = { ...cache.byCwd };
  if (trimmed.length === 0) {
    delete byId[sessionId];
  } else {
    byId[sessionId] = trimmed;
    if (cwd) byCwd[cwd] = trimmed;
  }
  cache = { byId, byCwd };
  write(cache);
  notify();
}

// React hook — live label that updates the instant any other component
// renames. Pass cwd so we get the cwd-inherited fallback too.
export function useTabLabel(sessionId: string, cwd?: string): string | null {
  return useSyncExternalStore(
    (cb) => { subs.add(cb); return () => subs.delete(cb); },
    () => cache.byId[sessionId] ?? (cwd ? cache.byCwd[cwd] ?? null : null),
    () => null
  );
}
