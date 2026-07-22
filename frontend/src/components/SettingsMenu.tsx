import { useEffect, useRef, useState } from 'react';
import {
  fetchRecapSettings,
  getPushVapidPublicKey,
  subscribePush,
  unsubscribePush,
  updateRecapSettings,
  type RecapProvider,
  type RecapSettings
} from '../api/sessionsd';
import { type TextSize, nextSize, sizeLabel, writeTextSize } from '../lib/textSize';
import {
  NEW_SESSION_DIMENSIONS,
  isNewSessionTool,
  normalizeNewSessionDefaults,
  readNewSessionDefaults,
  type NewSessionDefaults,
  type NewSessionTool,
  writeNewSessionDefaults
} from '../lib/newSessionDefaults';
import { ServerSelector } from './ServerSelector';
import { TagEditor } from './TagEditor';
import { claimCurrentOriginPairing } from '../lib/hostedBootstrap';
import {
  checkForNativeUpdate,
  installNativeUpdate,
  isTauri,
  notifyNativeUpdate,
  type NativeUpdateInfo,
  type NativeUpdateProgress
} from '../lib/tauriBridge';

interface Props {
  textSize: TextSize;
  onTextSizeChange: (size: TextSize) => void;
  onNewSession?: () => void;
  onOpenConnections?: () => void;
}

const PUSH_ENABLED_KEY = 'sessions:push-enabled';
const UPDATE_CHECK_KEY = 'sessions:native-update-check-at';
const UPDATE_NOTIFIED_KEY = 'sessions:native-update-notified-version';
const UPDATE_CHECK_INTERVAL = 6 * 60 * 60 * 1000;

const NEW_SESSION_TOOL_OPTIONS: { id: NewSessionTool; label: string }[] = [
  { id: 'claude-code', label: 'Claude Code' },
  { id: 'codex', label: 'Codex' },
  { id: 'shell', label: 'Shell' }
];

function readPushEnabled(): boolean {
  try {
    return window.localStorage.getItem(PUSH_ENABLED_KEY) === '1';
  } catch {
    return false;
  }
}

function writePushEnabled(enabled: boolean): void {
  try {
    if (enabled) window.localStorage.setItem(PUSH_ENABLED_KEY, '1');
    else window.localStorage.removeItem(PUSH_ENABLED_KEY);
  } catch { /* ignore */ }
}

function urlBase64ToUint8Array(base64: string): Uint8Array<ArrayBuffer> {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4);
  const normalized = `${base64}${padding}`.replace(/-/g, '+').replace(/_/g, '/');
  const raw = window.atob(normalized);
  const output = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) {
    output[i] = raw.charCodeAt(i);
  }
  return output;
}

async function getPushRegistration(): Promise<ServiceWorkerRegistration> {
  const scope = new URL('.', document.baseURI);
  const existing = await navigator.serviceWorker.getRegistration(scope.href);
  if (existing) return existing;
  if (import.meta.env.DEV) {
    throw new Error('Requires daemon-hosted HTTPS (enable tailscale serve)');
  }
  return navigator.serviceWorker.register(new URL('sw.js', scope), { scope: scope.pathname });
}

// Settings popover anchored to a header button.
export function SettingsMenu({ textSize, onTextSizeChange, onNewSession, onOpenConnections }: Props): JSX.Element {
  const [open, setOpen] = useState(false);
  const [pushEnabled, setPushEnabled] = useState(readPushEnabled);
  const [pushBusy, setPushBusy] = useState(false);
  const [pushMessage, setPushMessage] = useState<string | null>(null);
  const [pairTicket, setPairTicket] = useState('');
  const [pairBusy, setPairBusy] = useState(false);
  const [pairMessage, setPairMessage] = useState<string | null>(null);
  const [updateInfo, setUpdateInfo] = useState<NativeUpdateInfo | null>(null);
  const [updateProgress, setUpdateProgress] = useState<NativeUpdateProgress | null>(null);
  const [updateBusy, setUpdateBusy] = useState(false);
  const [updateMessage, setUpdateMessage] = useState<string | null>(null);
  const [recapSettings, setRecapSettings] = useState<RecapSettings>({ provider: 'off' });
  const [recapBusy, setRecapBusy] = useState(false);
  const [recapMessage, setRecapMessage] = useState<string | null>(null);
  const [sessionDefaults, setSessionDefaults] = useState<NewSessionDefaults>(readNewSessionDefaults);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent): void => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', onDown);
    return () => document.removeEventListener('pointerdown', onDown);
  }, [open]);

  useEffect(() => {
    const controller = new AbortController();
    void fetchRecapSettings(controller.signal)
      .then(setRecapSettings)
      .catch(() => { /* an older daemon may not have recap settings yet */ });
    return () => controller.abort();
  }, []);

  useEffect(() => {
    if (!isTauri()) return;
    let cancelled = false;
    const automaticCheck = async (): Promise<void> => {
      let last = 0;
      try { last = Number(window.localStorage.getItem(UPDATE_CHECK_KEY) ?? 0); } catch { /* ignore */ }
      if (Date.now() - last < UPDATE_CHECK_INTERVAL) return;
      try {
        const available = await checkForNativeUpdate();
        if (cancelled) return;
        try { window.localStorage.setItem(UPDATE_CHECK_KEY, String(Date.now())); } catch { /* ignore */ }
        if (!available) return;
        setUpdateInfo(available);
        let notified = '';
        try { notified = window.localStorage.getItem(UPDATE_NOTIFIED_KEY) ?? ''; } catch { /* ignore */ }
        if (notified !== available.version) {
          await notifyNativeUpdate(available).catch(() => { /* in-app badge remains authoritative */ });
          try { window.localStorage.setItem(UPDATE_NOTIFIED_KEY, available.version); } catch { /* ignore */ }
        }
      } catch {
        // Automatic checks stay silent. Manual checks retain actionable errors.
      }
    };
    const startup = window.setTimeout(() => void automaticCheck(), 1_500);
    const interval = window.setInterval(() => void automaticCheck(), UPDATE_CHECK_INTERVAL);
    return () => { cancelled = true; window.clearTimeout(startup); window.clearInterval(interval); };
  }, []);

  const cycleSize = (): void => {
    const next = nextSize(textSize);
    writeTextSize(next);
    onTextSizeChange(next);
  };

  const saveSessionDefaults = (patch: Partial<NewSessionDefaults>): void => {
    setSessionDefaults((current) => {
      const next = normalizeNewSessionDefaults({ ...current, ...patch });
      writeNewSessionDefaults(next);
      return next;
    });
  };

  const saveRecapSettings = async (next: RecapSettings): Promise<void> => {
    if (recapBusy) return;
    setRecapBusy(true);
    setRecapMessage(null);
    setRecapSettings(next);
    try {
      setRecapSettings(await updateRecapSettings(next));
      setRecapMessage(next.provider === 'off' ? 'Daily model calls are off' : `${next.provider === 'codex' ? 'Codex' : 'Claude'} will write recaps only when requested`);
    } catch (error) {
      setRecapMessage(error instanceof Error ? error.message : 'Could not save recap settings');
    } finally {
      setRecapBusy(false);
    }
  };

  const enablePush = async (): Promise<void> => {
    if (!window.isSecureContext) {
      setPushMessage('Requires HTTPS (enable tailscale serve)');
      return;
    }
    if (
      typeof Notification === 'undefined' ||
      !('serviceWorker' in navigator) ||
      !('PushManager' in window)
    ) {
      setPushMessage('Push notifications are not supported in this browser');
      return;
    }
    if (Notification.permission === 'denied') {
      setPushMessage('Notifications are blocked in browser settings');
      return;
    }

    const permission = Notification.permission === 'granted'
      ? 'granted'
      : await Notification.requestPermission();
    if (permission !== 'granted') {
      setPushMessage('Notification permission was not granted');
      return;
    }

    const publicKey = await getPushVapidPublicKey();
    const registration = await getPushRegistration();
    const existing = await registration.pushManager.getSubscription();
    const subscription = existing ?? await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(publicKey)
    });
    await subscribePush(subscription);
    writePushEnabled(true);
    setPushEnabled(true);
    setPushMessage('Notifications enabled');
  };

  const disablePush = async (): Promise<void> => {
    let endpoint: string | null = null;
    if ('serviceWorker' in navigator) {
      const registration = await navigator.serviceWorker.getRegistration(new URL('.', document.baseURI).href);
      const subscription = await registration?.pushManager.getSubscription();
      if (subscription) {
        endpoint = subscription.endpoint;
        try { await subscription.unsubscribe(); } catch { /* best effort */ }
      }
    }
    let cleanupError: string | null = null;
    if (endpoint) {
      try {
        await unsubscribePush(endpoint);
      } catch (err) {
        cleanupError = (err as Error).message;
      }
    }
    writePushEnabled(false);
    setPushEnabled(false);
    setPushMessage(cleanupError ? `Disabled locally; daemon cleanup failed: ${cleanupError}` : 'Notifications disabled');
  };

  const togglePush = async (): Promise<void> => {
    if (pushBusy) return;
    setPushBusy(true);
    setPushMessage(null);
    try {
      if (pushEnabled) await disablePush();
      else await enablePush();
    } catch (err) {
      setPushMessage((err as Error).message);
    } finally {
      setPushBusy(false);
    }
  };

  const claimPairTicket = async (): Promise<void> => {
    if (pairBusy || !pairTicket.trim()) return;
    setPairBusy(true);
    setPairMessage(null);
    try {
      const claimed = await claimCurrentOriginPairing(pairTicket);
      setPairTicket('');
      setPairMessage(`Paired as ${claimed.name}`);
    } catch (error) {
      setPairMessage(error instanceof Error ? error.message : 'Pairing failed. Run `sessions pair` again.');
    } finally {
      setPairBusy(false);
    }
  };

  const checkForUpdate = async (): Promise<void> => {
    if (updateBusy) return;
    setUpdateBusy(true);
    setUpdateMessage(null);
    setUpdateProgress(null);
    try {
      const available = await checkForNativeUpdate();
      setUpdateInfo(available);
      setUpdateMessage(available ? null : 'Sessions is up to date');
    } catch (error) {
      setUpdateInfo(null);
      setUpdateMessage(error instanceof Error ? error.message : 'Could not check for updates');
    } finally {
      setUpdateBusy(false);
    }
  };

  const installUpdate = async (): Promise<void> => {
    if (!updateInfo || updateBusy) return;
    setUpdateBusy(true);
    setUpdateMessage('Downloading update…');
    try {
      await installNativeUpdate((progress) => {
        setUpdateProgress(progress);
        if (progress.totalBytes) {
          const percent = Math.min(100, Math.round((progress.downloadedBytes / progress.totalBytes) * 100));
          setUpdateMessage(`Downloading update… ${percent}%`);
        }
      });
    } catch (error) {
      setUpdateMessage(error instanceof Error ? error.message : 'Could not install update');
      setUpdateBusy(false);
    }
  };

  return (
    <div className="settings-menu" ref={wrapRef}>
      <button
        type="button"
        className="settings-menu-trigger"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        title="Settings"
      >
        ⚙
        {updateInfo ? <span className="settings-update-dot" aria-label={`Sessions ${updateInfo.version} available`} /> : null}
      </button>
      {open ? (
        <div className="settings-menu-popover" role="menu">
          {onNewSession ? (
            <button
              type="button"
              className="settings-menu-row settings-menu-clickable"
              onClick={() => { setOpen(false); onNewSession(); }}
            >
              <span className="settings-menu-icon">+</span>
              <span className="settings-menu-label">New session</span>
            </button>
          ) : null}
          <button
            type="button"
            className="settings-menu-row settings-menu-clickable"
            onClick={cycleSize}
            title="Cycle text size: Small → Medium → Large"
          >
            <span className="settings-menu-icon">Aa</span>
            <span className="settings-menu-label">Text size</span>
            <span className="settings-menu-value">{sizeLabel(textSize)}</span>
          </button>
          <div className="settings-menu-divider" />
          <div className="settings-menu-section" aria-label="Default new-session options">
            <div className="settings-menu-section-title">Default new-session options</div>
            <label className="settings-menu-field">
              <span>Tool</span>
              <select
                className="settings-menu-input"
                value={sessionDefaults.tool}
                onChange={(e) => {
                  if (isNewSessionTool(e.currentTarget.value)) {
                    saveSessionDefaults({ tool: e.currentTarget.value });
                  }
                }}
              >
                {NEW_SESSION_TOOL_OPTIONS.map((option) => (
                  <option key={option.id} value={option.id}>{option.label}</option>
                ))}
              </select>
            </label>
            <label className="settings-menu-row settings-menu-toggle settings-menu-default-toggle">
              <input
                type="checkbox"
                checked={sessionDefaults.skipPerms}
                onChange={(e) => saveSessionDefaults({ skipPerms: e.currentTarget.checked })}
              />
              <span className="settings-menu-label">Skip permissions by default</span>
              <span className="settings-menu-value">{sessionDefaults.skipPerms ? 'On' : 'Off'}</span>
            </label>
            <label className="settings-menu-field">
              <span>Default cwd</span>
              <input
                className="settings-menu-input settings-menu-path-input"
                type="text"
                value={sessionDefaults.cwd}
                onChange={(e) => saveSessionDefaults({ cwd: e.currentTarget.value })}
                placeholder="Server default"
                spellCheck={false}
                autoCorrect="off"
                autoCapitalize="off"
              />
            </label>
            <div className="settings-menu-field-row">
              <label className="settings-menu-field">
                <span>Cols</span>
                <input
                  className="settings-menu-input"
                  type="number"
                  min={NEW_SESSION_DIMENSIONS.minCols}
                  max={NEW_SESSION_DIMENSIONS.maxCols}
                  value={sessionDefaults.cols}
                  onChange={(e) => saveSessionDefaults({ cols: e.currentTarget.valueAsNumber })}
                />
              </label>
              <label className="settings-menu-field">
                <span>Rows</span>
                <input
                  className="settings-menu-input"
                  type="number"
                  min={NEW_SESSION_DIMENSIONS.minRows}
                  max={NEW_SESSION_DIMENSIONS.maxRows}
                  value={sessionDefaults.rows}
                  onChange={(e) => saveSessionDefaults({ rows: e.currentTarget.valueAsNumber })}
                />
              </label>
            </div>
            <div className="settings-menu-field settings-menu-default-tags">
              <span>Default tags</span>
              <TagEditor
                value={sessionDefaults.tags}
                onChange={(tags) => saveSessionDefaults({ tags })}
              />
              <span className="settings-menu-field-hint">Inherited by future sessions and always editable before start.</span>
            </div>
          </div>
          <label className="settings-menu-row settings-menu-toggle">
            <input
              type="checkbox"
              checked={pushEnabled}
              onChange={() => void togglePush()}
              disabled={pushBusy}
            />
            <span className="settings-menu-label">Notify when a session finishes</span>
            <span className="settings-menu-value">{pushBusy ? '...' : pushEnabled ? 'On' : 'Off'}</span>
          </label>
          {pushMessage ? (
            <div className="settings-menu-status">{pushMessage}</div>
          ) : null}
          <div className="settings-menu-divider" />
          <div className="settings-menu-section" aria-label="Daily recap">
            <div className="settings-menu-section-title">Daily recap</div>
            <label className="settings-menu-field">
              <span>Writer</span>
              <select
                className="settings-menu-input"
                value={recapSettings.provider}
                disabled={recapBusy}
                onChange={(event) => void saveRecapSettings({ ...recapSettings, provider: event.currentTarget.value as RecapProvider })}
              >
                <option value="off">Off · no model calls</option>
                <option value="codex">Codex · recommended</option>
                <option value="claude">Claude</option>
              </select>
            </label>
            <label className="settings-menu-field">
              <span>Cheap model override</span>
              <input
                className="settings-menu-input"
                value={recapSettings.model ?? ''}
                disabled={recapBusy || recapSettings.provider === 'off'}
                onChange={(event) => setRecapSettings({ ...recapSettings, model: event.currentTarget.value })}
                onBlur={() => void saveRecapSettings(recapSettings)}
                placeholder="Provider default, tera, or luna"
              />
            </label>
            <span className="settings-menu-field-hint">One compact, manually requested call. Full transcripts are not sent.</span>
            {recapMessage ? <div className="settings-menu-status">{recapMessage}</div> : null}
          </div>
          {isTauri() ? (
            <>
              <div className="settings-menu-divider" />
              <div className="settings-menu-section" aria-label="App updates">
                <div className="settings-menu-section-title">Sessions updates</div>
                {updateInfo ? (
                  <button
                    type="button"
                    className="settings-menu-row settings-menu-clickable"
                    disabled={updateBusy}
                    onClick={() => void installUpdate()}
                  >
                    <span className="settings-menu-icon">↥</span>
                    <span className="settings-menu-label">Install Sessions {updateInfo.version}</span>
                    <span className="settings-menu-value">Restart app</span>
                  </button>
                ) : (
                  <button
                    type="button"
                    className="settings-menu-row settings-menu-clickable"
                    disabled={updateBusy}
                    onClick={() => void checkForUpdate()}
                  >
                    <span className="settings-menu-icon">↻</span>
                    <span className="settings-menu-label">Check for updates</span>
                    <span className="settings-menu-value">{updateBusy ? 'Checking…' : ''}</span>
                  </button>
                )}
                {updateMessage ? (
                  <div className="settings-menu-status" role="status">{updateMessage}</div>
                ) : null}
                {updateBusy && updateProgress?.totalBytes ? (
                  <progress
                    className="settings-menu-progress"
                    value={updateProgress.downloadedBytes}
                    max={updateProgress.totalBytes}
                    aria-label="Update download progress"
                  />
                ) : null}
                {updateInfo?.notes ? (
                  <div className="settings-menu-update-notes">{updateInfo.notes}</div>
                ) : null}
                {updateInfo ? (
                  <div className="settings-menu-update-safe">Sessions keep running while the app restarts.</div>
                ) : null}
              </div>
            </>
          ) : null}
          {onOpenConnections ? (
            <>
              <div className="settings-menu-divider" />
              <button
                type="button"
                className="settings-menu-row settings-menu-clickable"
                onClick={() => { setOpen(false); onOpenConnections(); }}
              >
                <span className="settings-menu-icon">⌁</span>
                <span className="settings-menu-label">Connections, Tailscale, and port</span>
                <span className="settings-menu-value">Open</span>
              </button>
            </>
          ) : null}
          {/* Server selector — "this machine" + IP picker. Tucked into
              Settings because the user doesn't need to see the host:port
              in the chrome all the time; it only matters when switching
              between machines. */}
          <div className="settings-menu-divider" />
          <div className="settings-menu-section" aria-label="Pair">
            <div className="settings-menu-section-title">Pair this browser</div>
            <div className="settings-menu-field-row">
              <label className="settings-menu-field">
                <span>Ticket</span>
                <input
                  className="settings-menu-input"
                  type="text"
                  value={pairTicket}
                  onChange={(event) => setPairTicket(event.currentTarget.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') void claimPairTicket();
                  }}
                  placeholder="From sessions pair"
                  autoComplete="off"
                  spellCheck={false}
                />
              </label>
              <button
                type="button"
                className="btn settings-menu-clickable"
                disabled={pairBusy || !pairTicket.trim()}
                onClick={() => void claimPairTicket()}
              >
                {pairBusy ? 'Pairing…' : 'Pair'}
              </button>
            </div>
            {pairMessage ? (
              <div className="settings-menu-status" role="status">{pairMessage}</div>
            ) : null}
          </div>
          <div className="settings-menu-divider" />
          <div className="settings-menu-row settings-menu-server">
            <span className="settings-menu-icon">🖥</span>
            <ServerSelector />
          </div>
        </div>
      ) : null}
    </div>
  );
}
