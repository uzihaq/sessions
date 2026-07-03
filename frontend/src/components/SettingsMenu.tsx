import { useEffect, useRef, useState } from 'react';
import {
  isTauri,
  getAutostartEnabled,
  setAutostartEnabled
} from '../lib/tauriBridge';
import { getPushVapidPublicKey, subscribePush, unsubscribePush } from '../api/prettyd';
import { type TextSize, nextSize, sizeLabel, writeTextSize } from '../lib/textSize';
import { ServerSelector } from './ServerSelector';

interface Props {
  textSize: TextSize;
  onTextSizeChange: (size: TextSize) => void;
  onNewSession?: () => void;
}

const PUSH_ENABLED_KEY = 'pretty-pty:push-enabled';

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
  const existing = await navigator.serviceWorker.getRegistration('/');
  if (existing) return existing;
  if (import.meta.env.DEV) {
    throw new Error('Requires daemon-hosted HTTPS (enable tailscale serve)');
  }
  return navigator.serviceWorker.register('/sw.js', { scope: '/' });
}

// Settings popover anchored to a header button. Visible everywhere
// because the text-size picker matters for both browser + Tauri;
// the autostart row only renders in Tauri.
export function SettingsMenu({ textSize, onTextSizeChange, onNewSession }: Props): JSX.Element {
  const tauri = isTauri();
  const [open, setOpen] = useState(false);
  const [autostart, setAutostart] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [pushEnabled, setPushEnabled] = useState(readPushEnabled);
  const [pushBusy, setPushBusy] = useState(false);
  const [pushMessage, setPushMessage] = useState<string | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!tauri || !open) return;
    let cancelled = false;
    void getAutostartEnabled().then((v) => {
      if (!cancelled) {
        setAutostart(v);
        setLoaded(true);
      }
    });
    return () => { cancelled = true; };
  }, [tauri, open]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent): void => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', onDown);
    return () => document.removeEventListener('pointerdown', onDown);
  }, [open]);

  const toggleAutostart = async (): Promise<void> => {
    const next = !autostart;
    setAutostart(next);
    await setAutostartEnabled(next);
  };

  const cycleSize = (): void => {
    const next = nextSize(textSize);
    writeTextSize(next);
    onTextSizeChange(next);
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
      const registration = await navigator.serviceWorker.getRegistration('/');
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
          {tauri ? (
            <label className="settings-menu-row">
              <input
                type="checkbox"
                checked={autostart}
                onChange={() => void toggleAutostart()}
                disabled={!loaded}
              />
              <span>Launch at login</span>
            </label>
          ) : null}
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
          <div className="settings-menu-row settings-menu-server">
            <span className="settings-menu-icon">🖥</span>
            <ServerSelector />
          </div>
        </div>
      ) : null}
    </div>
  );
}
