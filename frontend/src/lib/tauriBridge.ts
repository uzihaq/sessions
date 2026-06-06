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
  if (isTauri()) {
    await invoke<void>('open_session_window', { sessionId, title });
    return;
  }
  const url = `${window.location.origin}${window.location.pathname}?session=${encodeURIComponent(sessionId)}&mode=single`;
  const w = window.open(url, '_blank', 'noopener,noreferrer');
  if (!w) {
    // Last-resort fallback — some hardened browsers block window.open
    // entirely from background contexts. Force-navigate the current
    // tab; the user can use the back button to return.
    console.warn('window.open returned null — popup blocker? Falling back to same-tab nav.');
  }
}

// Fire a desktop notification for working→idle transitions etc. Tauri
// uses its native plugin (macOS notification center); browser uses the
// Notification API. Both are best-effort — silently no-op if perms are
// denied or the plugin isn't loaded.
export async function notify(title: string, body: string): Promise<void> {
  if (isTauri()) {
    try {
      const mod = await import('@tauri-apps/plugin-notification');
      const granted = await mod.isPermissionGranted();
      const ok = granted || (await mod.requestPermission()) === 'granted';
      if (ok) mod.sendNotification({ title, body });
    } catch {
      // plugin not installed yet (dev) — silently skip
    }
    return;
  }
  if (typeof Notification === 'undefined') return;
  if (Notification.permission === 'granted') {
    new Notification(title, { body });
  } else if (Notification.permission !== 'denied') {
    const perm = await Notification.requestPermission();
    if (perm === 'granted') new Notification(title, { body });
  }
}

// Read/write the "launch at login" preference. Tauri-only — in browser
// it's a no-op + reports false.
export async function getAutostartEnabled(): Promise<boolean> {
  if (!isTauri()) return false;
  try {
    const mod = await import('@tauri-apps/plugin-autostart');
    return mod.isEnabled();
  } catch {
    return false;
  }
}

export async function setAutostartEnabled(enabled: boolean): Promise<void> {
  if (!isTauri()) return;
  try {
    const mod = await import('@tauri-apps/plugin-autostart');
    if (enabled) await mod.enable();
    else await mod.disable();
  } catch {
    // best effort
  }
}
