import { create } from 'zustand';
import * as api from '../api/prettyd';
import type { CreateSessionRequest, SessionInfo } from '../types';

interface SessionsState {
  sessions: SessionInfo[];
  activeId: string | null;
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  create: (req: CreateSessionRequest) => Promise<SessionInfo>;
  kill: (id: string) => Promise<void>;
  setActive: (id: string | null) => void;
}

export const useSessions = create<SessionsState>((set, get) => ({
  sessions: [],
  activeId: null,
  loading: false,
  error: null,

  refresh: async () => {
    set({ loading: true, error: null });
    try {
      const sessions = await api.listSessions();
      const active = get().activeId;
      const stillExists = active && sessions.some((s) => s.id === active);
      set({
        sessions,
        loading: false,
        activeId: stillExists ? active : (sessions[0]?.id ?? null)
      });
    } catch (err) {
      set({ loading: false, error: (err as Error).message });
    }
  },

  create: async (req) => {
    const info = await api.createSession(req);
    set((s) => ({ sessions: [...s.sessions, info], activeId: info.id }));
    return info;
  },

  kill: async (id) => {
    await api.killSession(id);
    set((s) => {
      const remaining = s.sessions.filter((x) => x.id !== id);
      const nextActive = s.activeId === id ? (remaining[0]?.id ?? null) : s.activeId;
      return { sessions: remaining, activeId: nextActive };
    });
  },

  setActive: (id) => set({ activeId: id })
}));
