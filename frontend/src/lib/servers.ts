import { create } from 'zustand';
import { randomUUID } from './uuid';

// A "server" is a prettyd instance reachable over the network. The user can
// have multiple — their Mac Mini on Tailscale, their local MacBook, a Fly
// machine, etc. — and switch between them. The frontend changes its REST/WS
// base URLs based on whichever server is active. localStorage persists the
// list across reloads.

export interface ServerConfig {
  id: string;
  name: string;
  host: string;
  port: number;
  isDefault: boolean;
  // Optional auth token (contract #1).  When present every HTTP request
  // carries `Authorization: Bearer <token>` and every WS URL gets
  // `?token=<token>` appended.  Absent → no auth (open daemon).
  token?: string;
  // Transport scheme.  Defaults to 'http' so existing stored configs
  // (which have no scheme field) continue to work without migration.
  scheme?: 'http' | 'https';
}

const STORAGE_KEY = 'pretty-pty:servers';
const ACTIVE_KEY = 'pretty-pty:active-server';

const LOCAL_DEFAULT: ServerConfig = {
  id: 'local',
  name: 'This machine',
  host: '127.0.0.1',
  port: 8787,
  isDefault: true
};

function readServers(): ServerConfig[] {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [LOCAL_DEFAULT];
    const parsed = JSON.parse(raw) as ServerConfig[];
    if (!Array.isArray(parsed) || parsed.length === 0) return [LOCAL_DEFAULT];
    return parsed;
  } catch {
    return [LOCAL_DEFAULT];
  }
}

function writeServers(servers: ServerConfig[]): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(servers));
  } catch { /* quota / private mode — non-fatal */ }
}

function readActiveId(): string {
  try {
    return window.localStorage.getItem(ACTIVE_KEY) ?? '';
  } catch {
    return '';
  }
}

function writeActiveId(id: string): void {
  try {
    window.localStorage.setItem(ACTIVE_KEY, id);
  } catch { /* ignore */ }
}

interface ServersStore {
  servers: ServerConfig[];
  activeId: string;
  addServer: (s: Omit<ServerConfig, 'id' | 'isDefault'>) => ServerConfig;
  removeServer: (id: string) => void;
  // Patch fields on an existing server (e.g. save a token entered after a
  // 401, or flip scheme). Persists to localStorage like the other mutators.
  updateServer: (id: string, updates: Partial<Omit<ServerConfig, 'id' | 'isDefault'>>) => void;
  setActive: (id: string) => void;
  // Resolve the live config for the active server. Falls back to the
  // default if the saved active id no longer exists (e.g. user removed
  // it on another tab).
  active: () => ServerConfig;
}

const initial = (() => {
  const servers = readServers();
  const savedActive = readActiveId();
  const activeId = servers.some((s) => s.id === savedActive)
    ? savedActive
    : (servers.find((s) => s.isDefault) ?? servers[0]!).id;
  return { servers, activeId };
})();

export const useServers = create<ServersStore>((set, get) => ({
  servers: initial.servers,
  activeId: initial.activeId,

  addServer: (s) => {
    const next: ServerConfig = {
      ...s,
      id: randomUUID(),
      isDefault: false
    };
    set((state) => {
      const servers = [...state.servers, next];
      writeServers(servers);
      return { servers };
    });
    return next;
  },

  removeServer: (id) => {
    set((state) => {
      // Never remove the local default — there must always be at least one.
      const target = state.servers.find((s) => s.id === id);
      if (!target || target.isDefault) return state;
      const servers = state.servers.filter((s) => s.id !== id);
      writeServers(servers);
      const activeId = state.activeId === id
        ? (servers.find((s) => s.isDefault) ?? servers[0]!).id
        : state.activeId;
      if (activeId !== state.activeId) writeActiveId(activeId);
      return { servers, activeId };
    });
  },

  updateServer: (id, updates) => {
    set((state) => {
      const servers = state.servers.map((s) =>
        s.id === id ? { ...s, ...updates } : s
      );
      writeServers(servers);
      return { servers };
    });
  },

  setActive: (id) => {
    if (!get().servers.some((s) => s.id === id)) return;
    writeActiveId(id);
    set({ activeId: id });
  },

  active: () => {
    const { servers, activeId } = get();
    return servers.find((s) => s.id === activeId)
      ?? servers.find((s) => s.isDefault)
      ?? servers[0]
      ?? LOCAL_DEFAULT;
  }
}));

// Non-reactive accessor for use inside api/prettyd.ts and similar — those
// functions are called per request, and reading the latest value out of
// the store at call time is exactly what we want.
export function getActiveServer(): ServerConfig {
  return useServers.getState().active();
}

// "Local" servers represent "the prettyd that this page's Vite is
// already proxying for" — in browser those should use relative URLs so
// the Vite proxy handles the loopback hop, instead of the frontend
// trying (and failing) to talk to 127.0.0.1 from a different machine.
export function isLocalServer(s: ServerConfig): boolean {
  return s.host === '127.0.0.1' || s.host === 'localhost' || s.host === '::1';
}
