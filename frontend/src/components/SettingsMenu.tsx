import { useEffect, useRef, useState } from 'react';
import { getPushVapidPublicKey, subscribePush, unsubscribePush } from '../api/prettyd';
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
import { claimCurrentOriginPairing } from '../lib/hostedBootstrap';

interface Props {
  textSize: TextSize;
  onTextSizeChange: (size: TextSize) => void;
  onNewSession?: () => void;
}

const PUSH_ENABLED_KEY = 'pretty-pty:push-enabled';

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
export function SettingsMenu({ textSize, onTextSizeChange, onNewSession }: Props): JSX.Element {
  const [open, setOpen] = useState(false);
  const [pushEnabled, setPushEnabled] = useState(readPushEnabled);
  const [pushBusy, setPushBusy] = useState(false);
  const [pushMessage, setPushMessage] = useState<string | null>(null);
  const [pairTicket, setPairTicket] = useState('');
  const [pairBusy, setPairBusy] = useState(false);
  const [pairMessage, setPairMessage] = useState<string | null>(null);
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
      setPairMessage(error instanceof Error ? error.message : 'Pairing failed. Run `pretty pair` again.');
    } finally {
      setPairBusy(false);
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
                  placeholder="From pretty pair"
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
