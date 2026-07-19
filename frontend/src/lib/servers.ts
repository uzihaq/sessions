import { create } from 'zustand';
import { randomUUID } from './uuid';
import { isTauri } from './tauriBridge';
import { readWindowScope } from './windowScope';

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

function embeddedServer(): ServerConfig | null {
  if (typeof window === 'undefined') return null;
  // Tauri's page origin is its asset protocol, not the daemon. A fresh
  // desktop install still needs to be zero-configuration and talk directly
  // to the loopback daemon managed by `pretty install`.
  if (isTauri()) {
    return {
      id: 'local',
      name: 'This machine',
      host: 'localhost',
      port: 8787,
      isDefault: true,
      scheme: 'http'
    };
  }
  const scheme = window.location.protocol === 'https:' ? 'https' : 'http';
  const port = window.location.port
    ? Number(window.location.port)
    : (scheme === 'https' ? 443 : 80);

  // The normal daemon origin should remain zero-configuration: the same
  // production build served by prettyd at localhost:8787 goes straight to
  // the session list. A static preview or hosted site uses another port and
  // deliberately starts with no server, so its first paint is the picker.
  if (port !== 8787) return null;
  return {
    id: 'local',
    name: 'This machine',
    host: window.location.hostname,
    port,
    isDefault: true,
    scheme
  };
}

function readServers(): ServerConfig[] {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      const embedded = embeddedServer();
      return embedded ? [embedded] : [];
    }
    const parsed = JSON.parse(raw) as ServerConfig[];
    if (!Array.isArray(parsed)) return [];
    return parsed;
  } catch {
    return [];
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

function writeActiveId(id: string | null): void {
  try {
    if (id) window.localStorage.setItem(ACTIVE_KEY, id);
    else window.localStorage.removeItem(ACTIVE_KEY);
  } catch { /* ignore */ }
}

interface ServersStore {
  servers: ServerConfig[];
  activeId: string | null;
  // Runtime-only auth state for an embedded same-origin daemon. This is not
  // part of ServerConfig and is deliberately never persisted.
  tokenRequiredServerId: string | null;
  // Runtime-only error from an attempted one-time pairing claim. Keeping it
  // in the server store lets bootstrap surface the failure after React mounts
  // without putting the ticket back into the URL or persistent storage.
  pairingError: string | null;
  addServer: (s: Omit<ServerConfig, 'id' | 'isDefault'>) => ServerConfig;
  removeServer: (id: string) => void;
  // Patch fields on an existing server (e.g. save a token entered after a
  // 401, or flip scheme). Persists to localStorage like the other mutators.
  updateServer: (id: string, updates: Partial<Omit<ServerConfig, 'id' | 'isDefault'>>) => void;
  markTokenRequired: (id: string) => void;
  setPairingError: (error: string | null) => void;
  setActive: (id: string | null) => void;
  // Resolve the live config for the active server. Falls back to the
  // default if the saved active id no longer exists (e.g. user removed
  // it on another tab).
  active: () => ServerConfig | null;
}

const initial = (() => {
  const servers = readServers();
  const savedActive = readActiveId();
  const windowScope = readWindowScope();
  const scopedServerId = windowScope?.kind === 'server' ? windowScope.value : '';
  const activeId = servers.some((s) => s.id === scopedServerId)
    ? scopedServerId
    : servers.some((s) => s.id === savedActive)
    ? savedActive
    : (servers.find((s) => s.isDefault) ?? servers[0])?.id ?? null;
  return { servers, activeId };
})();

export const useServers = create<ServersStore>((set, get) => ({
  servers: initial.servers,
  activeId: initial.activeId,
  tokenRequiredServerId: null,
  pairingError: null,

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
      // Keep the daemon-origin entry stable. Hosted entries are removable;
      // removing the final one returns the user to the connection screen.
      const target = state.servers.find((s) => s.id === id);
      if (!target || target.isDefault) return state;
      const servers = state.servers.filter((s) => s.id !== id);
      writeServers(servers);
      const activeId = state.activeId === id
        ? (servers.find((s) => s.isDefault) ?? servers[0])?.id ?? null
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
      const tokenRequiredServerId = state.tokenRequiredServerId === id && updates.token
        ? null
        : state.tokenRequiredServerId;
      return { servers, tokenRequiredServerId };
    });
  },

  markTokenRequired: (id) => {
    if (!get().servers.some((s) => s.id === id)) return;
    set({ tokenRequiredServerId: id });
  },

  setPairingError: (error) => set({ pairingError: error }),

  setActive: (id) => {
    if (id === null) {
      writeActiveId(null);
      set({ activeId: null });
      return;
    }
    if (!get().servers.some((s) => s.id === id)) return;
    writeActiveId(id);
    set({ activeId: id });
  },

  active: () => {
    const { servers, activeId } = get();
    return servers.find((s) => s.id === activeId)
      ?? servers.find((s) => s.isDefault)
      ?? servers[0]
      ?? null;
  }
}));

function currentOriginServer(): ServerConfig {
  const scheme = window.location.protocol === 'https:' ? 'https' : 'http';
  const port = window.location.port
    ? Number(window.location.port)
    : (scheme === 'https' ? 443 : 80);
  return {
    id: 'local',
    name: 'This machine',
    host: window.location.hostname,
    port,
    isDefault: true,
    scheme
  };
}

function matchesCurrentOrigin(server: ServerConfig, current: ServerConfig): boolean {
  return (server.scheme ?? 'http') === current.scheme
    && server.host.toLowerCase() === current.host.toLowerCase()
    && server.port === current.port;
}

// Adopt the daemon serving this page, optionally attaching a freshly claimed
// per-device token. This is shared by the health-probe bootstrap and the
// pairing bootstrap so both paths create the same stable current-origin entry.
export function adoptCurrentOriginServer(
  token?: string,
  tokenRequired = false
): ServerConfig {
  const store = useServers.getState();
  const current = currentOriginServer();
  const existing = store.servers.find((server) => matchesCurrentOrigin(server, current));
  const tokenUpdate = token === undefined ? {} : { token: token.trim() || undefined };
  const adopted: ServerConfig = existing
    ? { ...existing, ...tokenUpdate, isDefault: true }
    : { ...current, ...tokenUpdate };
  const servers = existing
    ? store.servers.map((server) => server.id === existing.id ? adopted : server)
    : [...store.servers, adopted];

  writeServers(servers);
  writeActiveId(adopted.id);
  useServers.setState({
    servers,
    activeId: adopted.id,
    tokenRequiredServerId: tokenRequired ? adopted.id : null,
    pairingError: null
  });
  return adopted;
}

function hasStoredServerList(): boolean {
  try {
    return window.localStorage.getItem(STORAGE_KEY) !== null;
  } catch {
    // If storage cannot be inspected, preserve the existing picker behavior.
    return true;
  }
}

function isPrettydHealth(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false;
  const health = value as Record<string, unknown>;
  return health.ok === true || typeof health.name === 'string';
}

// A non-8787 page may still be the UI served by prettyd itself (for example
// its Tailscale HTTPS origin). With no saved configuration, probe that origin
// and adopt it only when the response identifies a daemon. Static hosted
// shells fall through unchanged when /api/health is absent or not prettyd.
export async function bootstrapCurrentOriginServer(): Promise<void> {
  if (typeof window === 'undefined') return;
  if (useServers.getState().servers.length > 0 || hasStoredServerList()) return;

  // The existing 8787 embeddedServer() path remains the fast path and must
  // never wait for a startup probe.
  if (embeddedServer()) return;

  let response: Response;
  try {
    response = await fetch(`${window.location.origin}/api/health`);
  } catch {
    return;
  }

  let tokenRequired = false;
  if (response.status === 401) {
    tokenRequired = true;
  } else if (response.status === 200) {
    try {
      if (!isPrettydHealth(await response.json())) return;
    } catch {
      return;
    }
  } else {
    return;
  }

  adoptCurrentOriginServer(undefined, tokenRequired);
}

// Non-reactive accessor for use inside api/prettyd.ts and similar — those
// functions are called per request, and reading the latest value out of
// the store at call time is exactly what we want.
export function getActiveServer(): ServerConfig {
  const server = useServers.getState().active();
  if (!server) throw new Error('No pretty server is configured.');
  return server;
}

// Local means the configured daemon is on browser loopback. It does not
// imply same-origin: a hosted HTTPS shell must still call the configured
// http://localhost endpoint directly rather than rewriting it to the site.
export function isLocalServer(s: ServerConfig): boolean {
  return s.host === '127.0.0.1' || s.host === 'localhost' || s.host === '::1' || s.host === '[::1]';
}
