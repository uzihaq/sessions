// Thin wrapper around Tauri APIs that survives running in a regular
// browser too. The desktop app loads the same React bundle as the
// browser; we feature-detect window.__TAURI_INTERNALS__ to decide
// whether to call invoke()/native plugins or fall back to web APIs
// (window.open, web Notification, etc.).
//
// All async — even in the browser path — so call sites don't have to
// branch on the runtime.

export const isTauri = (): boolean =>
  typeof window !== 'undefined' &&
  (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ !== undefined;

// Tauri 2: invoke() comes from @tauri-apps/api/core. We dynamic-import so
// the package is only loaded when actually running inside Tauri (avoids
// shipping the module to the phone PWA where it'd be dead weight).
async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const mod = await import('@tauri-apps/api/core');
  return mod.invoke<T>(cmd, args);
}

// Pop a single session into its own native window (Tauri) or a new
// browser tab (web). The Tauri command focuses an existing window for
// the same session id rather than stacking duplicates.
//
// Browser path opens as a TAB (no width/height in features) — Chrome
// and Safari treat any `window.open` with explicit dims as a popup,
// which is blocked by default popup-blocker rules even from a real
// user gesture. As a plain `_blank`, the browser opens it as a tab
// and the user can drag it out into its own window if they want.
export async function openSessionWindow(sessionId: string, title: string): Promise<void> {
  const query = new URLSearchParams({ session: sessionId, mode: 'single' }).toString();
  if (isTauri()) {
    await invoke<void>('open_scoped_window', { query, title });
    return;
  }
  const url = `${window.location.origin}${window.location.pathname}?${query}`;
  const w = window.open(url, '_blank', 'noopener,noreferrer');
  if (!w) {
    // Last-resort fallback — some hardened browsers block window.open
    // entirely from background contexts. Force-navigate the current
    // tab; the user can use the back button to return.
    console.warn('window.open returned null — popup blocker? Falling back to same-tab nav.');
  }
}

// Fire a browser notification for working→idle transitions. The native app
// intentionally leaves notifications to the daemon-hosted web push path.
export async function notify(title: string, body: string): Promise<void> {
  // v1 deliberately does not forward web activity into native
  // notifications. The daemon-hosted web push path remains authoritative,
  // which avoids duplicate alerts when the desktop shell is also open.
  if (isTauri()) return;
  if (typeof Notification === 'undefined') return;
  if (Notification.permission === 'granted') {
    new Notification(title, { body });
  } else if (Notification.permission !== 'denied') {
    const perm = await Notification.requestPermission();
    if (perm === 'granted') new Notification(title, { body });
  }
}

export interface TrayServer {
  id: string;
  name: string;
}

export async function syncTrayServers(servers: TrayServer[]): Promise<void> {
  if (!isTauri()) return;
  await invoke<void>('set_tray_servers', {
    servers: servers.map(({ id, name }) => ({ id, name }))
  });
}

export interface NativeRuntimeStatus {
  state: 'ready' | 'development' | 'client-only' | 'disabled' | 'error';
  detail: string;
  serviceLabel: string;
  runtimeVersion: string | null;
}

export async function getNativeRuntimeStatus(): Promise<NativeRuntimeStatus | null> {
  if (!isTauri()) return null;
  return invoke<NativeRuntimeStatus>('runtime_status');
}

export interface NativeUpdateInfo {
  currentVersion: string;
  version: string;
  notes: string | null;
  publishedAt: string | null;
}

export interface NativeUpdateProgress {
  downloadedBytes: number;
  totalBytes: number | null;
}

type PendingUpdate = Awaited<ReturnType<typeof import('@tauri-apps/plugin-updater')['check']>>;

let pendingUpdate: PendingUpdate = null;

export async function checkForNativeUpdate(): Promise<NativeUpdateInfo | null> {
  if (!isTauri()) return null;
  if (pendingUpdate) {
    await pendingUpdate.close();
    pendingUpdate = null;
  }
  const { check } = await import('@tauri-apps/plugin-updater');
  pendingUpdate = await check({ timeout: 12_000 });
  if (!pendingUpdate) return null;
  return {
    currentVersion: pendingUpdate.currentVersion,
    version: pendingUpdate.version,
    notes: pendingUpdate.body ?? null,
    publishedAt: pendingUpdate.date ?? null
  };
}

export async function installNativeUpdate(
  onProgress?: (progress: NativeUpdateProgress) => void
): Promise<void> {
  if (!isTauri()) throw new Error('Updates are available only in Sessions.app');
  if (!pendingUpdate) throw new Error('Check for an update first');

  let downloadedBytes = 0;
  let totalBytes: number | null = null;
  await pendingUpdate.downloadAndInstall((event) => {
    if (event.event === 'Started') {
      downloadedBytes = 0;
      totalBytes = event.data.contentLength ?? null;
    } else if (event.event === 'Progress') {
      downloadedBytes += event.data.chunkLength;
    } else if (event.event === 'Finished' && totalBytes !== null) {
      downloadedBytes = totalBytes;
    }
    onProgress?.({ downloadedBytes, totalBytes });
  });

  // Relaunch only the UI process. The daemon and every runner are launchd-owned
  // and remain alive across this replacement.
  const { relaunch } = await import('@tauri-apps/plugin-process');
  await relaunch();
}
