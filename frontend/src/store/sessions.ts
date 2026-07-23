import { create } from 'zustand';
import * as api from '../api/sessionsd';
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
// lastDataAt is render-relevant now: Home and the operations navigator use it
// for activity timestamps and ordering. The API is polled every three seconds,
// so accepting one re-render per changed session per poll keeps that UI honest
// without reverting to per-output-byte React updates.
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
      old.lastDataAt === f.lastDataAt &&
      old.lastUserMessageAt === f.lastUserMessageAt &&
      old.cwd === f.cwd &&
      old.cmd === f.cmd &&
      old.tool === f.tool &&
      old.kind === f.kind &&
      old.name === f.name &&
      old.description === f.description &&
      old.profile === f.profile &&
      old.configDir === f.configDir &&
      old.worktreePath === f.worktreePath &&
      old.branch === f.branch &&
      old.base === f.base &&
      old.sourceRepo === f.sourceRepo &&
      old.parentSessionId === f.parentSessionId &&
      old.creatorKind === f.creatorKind &&
      old.creatorId === f.creatorId &&
      old.rootCreatorKind === f.rootCreatorKind &&
      old.rootCreatorId === f.rootCreatorId &&
      old.provenanceStatus === f.provenanceStatus &&
      arrayEqual(old.creatorAncestry, f.creatorAncestry) &&
      old.model === f.model &&
      old.effort === f.effort &&
      old.fast === f.fast &&
      old.conversationId === f.conversationId &&
      old.cols === f.cols &&
      old.rows === f.rows &&
      old.pid === f.pid &&
      old.claudeCustomTitle === f.claudeCustomTitle &&
      old.claudeAiTitle === f.claudeAiTitle &&
      tagsEqual(old.tags, f.tags)
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

function arrayEqual(left: string[] | undefined, right: string[] | undefined): boolean {
  if (left === right) return true;
  if (!left || !right || left.length !== right.length) return false;
  return left.every((value, index) => value === right[index]);
}

function tagsEqual(
  left: Record<string, string> | undefined,
  right: Record<string, string> | undefined
): boolean {
  const leftEntries = Object.entries(left ?? {});
  const rightEntries = Object.entries(right ?? {});
  return leftEntries.length === rightEntries.length
    && leftEntries.every(([key, value]) => right?.[key] === value);
}

interface SessionsState {
  sessions: SessionInfo[];
  activeId: string | null;
  // Whether the store has rendered with at least one fresh refresh()
  // result from sessionsd. Stays false during the localStorage-hydrated
  // phase right after PWA cold-start. Lets the UI tell "this is the
  // last-known state, fetching fresh" from "this is live."
  hydrated: boolean;
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  create: (req: CreateSessionRequest) => Promise<SessionInfo>;
  kill: (id: string) => Promise<void>;
  updateTags: (id: string, tags: Record<string, string>) => Promise<void>;
  setActive: (id: string | null) => void;
}

// LocalStorage cache so the PWA can render the familiar tab strip
// instantly on cold-start before the WS / refresh round-trip lands.
// We only stash what the UI needs to draw a plausible first frame —
// not the full SessionInfo (working/lastDataAt are stale within
// seconds anyway). On refresh() the live data overwrites everything.
const CACHE_KEY = 'sessions:sessions-cache:v1';
const ACTIVE_KEY = 'sessions:active-session:v1';

interface CachedSession {
  id: string;
  name?: string;
  description?: string;
  tags?: Record<string, string>;
  cmd: string;
  args: string[];
  cwd: string;
  cols: number;
  rows: number;
  createdAt: number;
  pid: number;
  tool: SessionInfo['tool'];
  kind?: string;
  model?: string;
  effort?: string;
  fast?: boolean;
  conversationId?: string;
  profile?: string;
  configDir?: string;
  worktreePath?: string;
  branch?: string;
  base?: string;
  sourceRepo?: string;
  parentSessionId?: string;
  creatorKind?: string;
  creatorId?: string;
  creatorAncestry?: string[];
  rootCreatorKind?: string;
  rootCreatorId?: string;
  provenanceStatus?: string;
  working?: boolean;
  lastDataAt?: number;
  lastUserMessageAt?: number | null;
  exited?: boolean;
  exitCode?: number | null;
  exitSignal?: string | null;
  exitedAt?: number | null;
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
          working: c.working ?? false,
          lastDataAt: c.lastDataAt ?? c.createdAt,
          lastUserMessageAt: c.lastUserMessageAt ?? null,
          exited: c.exited ?? false,
          exitCode: c.exitCode ?? null,
          exitSignal: c.exitSignal ?? null,
          exitedAt: c.exitedAt ?? null
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
      name: s.name,
      description: s.description,
      tags: s.tags,
      cmd: s.cmd,
      args: s.args,
      cwd: s.cwd,
      cols: s.cols,
      rows: s.rows,
      createdAt: s.createdAt,
      pid: s.pid,
      tool: s.tool,
      kind: s.kind,
      model: s.model,
      effort: s.effort,
      fast: s.fast,
      conversationId: s.conversationId,
      profile: s.profile,
      configDir: s.configDir,
      worktreePath: s.worktreePath,
      branch: s.branch,
      base: s.base,
      sourceRepo: s.sourceRepo,
      parentSessionId: s.parentSessionId,
      creatorKind: s.creatorKind,
      creatorId: s.creatorId,
      creatorAncestry: s.creatorAncestry,
      rootCreatorKind: s.rootCreatorKind,
      rootCreatorId: s.rootCreatorId,
      provenanceStatus: s.provenanceStatus,
      working: s.working,
      lastDataAt: s.lastDataAt,
      lastUserMessageAt: s.lastUserMessageAt,
      exited: s.exited,
      exitCode: s.exitCode,
      exitSignal: s.exitSignal,
      exitedAt: s.exitedAt,
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
      const nextActive = stillExists
        ? active
        : (sessions.find((session) => !session.exited)?.id ?? sessions[0]?.id ?? null);
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
    // Ending a process is not deleting its history. Refresh immediately so
    // the row moves to Finished/Failed while its transcript and lineage stay
    // available in the operations inbox.
    await get().refresh();
  },

  updateTags: async (id, requested) => {
    const tags = await api.updateSessionTags(id, requested);
    set((state) => {
      const sessions = state.sessions.map((session) => (
        session.id === id ? { ...session, tags } : session
      ));
      writeCache(sessions, state.activeId);
      return { sessions };
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
