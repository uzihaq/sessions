import { create } from 'zustand';
import * as api from '../api/prettyd';
import type { CreateSessionRequest, SessionInfo } from '../types';
import {
  filterSessionsForWindow,
  readWindowScope,
  sessionMatchesWindowScope
} from '../lib/windowScope';

const windowScope = readWindowScope();

// Re-use the previous object for any session whose render-relevant fields
// are unchanged, so component selectors (`sessions.find(id)`) keep stable
// references across the 3s poll. Without this, every poll replaces all
// objects → every mounted SessionView re-renders on a timer (36 of them),
// a periodic main-thread hitch that shows up as laggy terminal input.
// lastDataAt is deliberately excluded — it climbs on every output byte but
// drives nothing visible on its own (the `working` flag is the live signal),
// and including it would defeat the reuse for any busy session.
function reconcileSessions(prev: SessionInfo[], fresh: SessionInfo[]): SessionInfo[] {
  const prevById = new Map(prev.map((s) => [s.id, s]));
  const next = fresh.map((f) => {
    const old = prevById.get(f.id);
    if (
      old &&
      old.working === f.working &&
      old.exited === f.exited &&
      old.exitCode === f.exitCode &&
      old.exitSignal === f.exitSignal &&
      old.exitedAt === f.exitedAt &&
      old.lastUserMessageAt === f.lastUserMessageAt &&
      old.cwd === f.cwd &&
      old.cmd === f.cmd &&
      old.tool === f.tool &&
      old.cols === f.cols &&
      old.rows === f.rows &&
      old.pid === f.pid &&
      old.claudeCustomTitle === f.claudeCustomTitle &&
      old.claudeAiTitle === f.claudeAiTitle
    ) {
      return old;
    }
    return f;
  });
  // If every element is the same object in the same order as before, return
  // the PREVIOUS array reference so subscribers to the whole `sessions` array
  // (App, SessionTabs, GridView) don't re-render at all on an idle 3s poll.
  if (next.length === prev.length && next.every((s, i) => s === prev[i])) return prev;
  return next;
}

interface SessionsState {
  sessions: SessionInfo[];
  activeId: string | null;
  // Whether the store has rendered with at least one fresh refresh()
  // result from prettyd. Stays false during the localStorage-hydrated
  // phase right after PWA cold-start. Lets the UI tell "this is the
  // last-known state, fetching fresh" from "this is live."
  hydrated: boolean;
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  create: (req: CreateSessionRequest) => Promise<SessionInfo>;
  kill: (id: string) => Promise<void>;
  setActive: (id: string | null) => void;
}

// LocalStorage cache so the PWA can render the familiar tab strip
// instantly on cold-start before the WS / refresh round-trip lands.
// We only stash what the UI needs to draw a plausible first frame —
// not the full SessionInfo (working/lastDataAt are stale within
// seconds anyway). On refresh() the live data overwrites everything.
const CACHE_KEY = 'pretty-pty:sessions-cache:v1';
const ACTIVE_KEY = 'pretty-pty:active-session:v1';

interface CachedSession {
  id: string;
  cmd: string;
  args: string[];
  cwd: string;
  cols: number;
  rows: number;
  createdAt: number;
  pid: number;
  tool: SessionInfo['tool'];
  // Cache Claude-side titles so the PWA cold-start renders the correct
  // tab label without a flash-of-wrong-name before live data arrives.
  claudeCustomTitle?: string;
  claudeAiTitle?: string;
}

function readCache(): { sessions: SessionInfo[]; activeId: string | null } {
  try {
    const raw = window.localStorage.getItem(CACHE_KEY);
    const sessions: SessionInfo[] = filterSessionsForWindow(raw
      ? (JSON.parse(raw) as CachedSession[]).map((c) => ({
          ...c,
          // Fill the live fields with neutral defaults — they'll be
          // overwritten by refresh() within ~1s of boot. We don't
          // pretend to know whether the cached session is still
          // working or even still alive.
          working: false,
          lastDataAt: c.createdAt,
          lastUserMessageAt: null,
          exited: false,
          exitCode: null,
          exitSignal: null,
          exitedAt: null
        }))
      : [], windowScope);
    const savedActiveId = window.localStorage.getItem(ACTIVE_KEY);
    const activeId = savedActiveId && sessions.some((session) => session.id === savedActiveId)
      ? savedActiveId
      : (sessions[0]?.id ?? null);
    return { sessions, activeId };
  } catch {
    return { sessions: [], activeId: null };
  }
}

function writeCache(sessions: SessionInfo[], activeId: string | null): void {
  try {
    const stripped: CachedSession[] = sessions.map((s) => ({
      id: s.id,
      cmd: s.cmd,
      args: s.args,
      cwd: s.cwd,
      cols: s.cols,
      rows: s.rows,
      createdAt: s.createdAt,
      pid: s.pid,
      tool: s.tool,
      // Persist titles so they survive a PWA cold-start without flashing.
      claudeCustomTitle: s.claudeCustomTitle,
      claudeAiTitle: s.claudeAiTitle
    }));
    window.localStorage.setItem(CACHE_KEY, JSON.stringify(stripped));
    if (activeId) window.localStorage.setItem(ACTIVE_KEY, activeId);
    else window.localStorage.removeItem(ACTIVE_KEY);
  } catch {
    // quota / private mode — drop the cache silently
  }
}

const initial = readCache();

export const useSessions = create<SessionsState>((set, get) => ({
  sessions: initial.sessions,
  activeId: initial.activeId,
  hydrated: false,
  loading: false,
  error: null,

  refresh: async () => {
    set({ loading: true, error: null });
    try {
      const fresh = filterSessionsForWindow(await api.listSessions(), windowScope);
      const sessions = reconcileSessions(get().sessions, fresh);
      const active = get().activeId;
      const stillExists = active && sessions.some((s) => s.id === active);
      const nextActive = stillExists ? active : (sessions[0]?.id ?? null);
      set({ sessions, loading: false, hydrated: true, activeId: nextActive });
      writeCache(sessions, nextActive);
    } catch (err) {
      set({ loading: false, error: (err as Error).message });
      // Don't clear the cached sessions on a transient fetch failure —
      // the user keeps seeing their last-known tabs while reconnect
      // attempts happen in the background.
    }
  },

  create: async (req) => {
    const info = await api.createSession(req);
    set((s) => {
      if (!sessionMatchesWindowScope(info, windowScope)) return s;
      const sessions = [...s.sessions, info];
      writeCache(sessions, info.id);
      return { sessions, activeId: info.id };
    });
    return info;
  },

  kill: async (id) => {
    await api.killSession(id);
    set((s) => {
      const remaining = s.sessions.filter((x) => x.id !== id);
      const nextActive = s.activeId === id ? (remaining[0]?.id ?? null) : s.activeId;
      writeCache(remaining, nextActive);
      return { sessions: remaining, activeId: nextActive };
    });
  },

  setActive: (id) => {
    set({ activeId: id });
    try {
      if (id) window.localStorage.setItem(ACTIVE_KEY, id);
      else window.localStorage.removeItem(ACTIVE_KEY);
    } catch { /* ignore */ }
  }
}));
