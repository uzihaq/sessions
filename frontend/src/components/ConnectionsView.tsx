import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { fetchLANState, setLANEnabled, type LANState } from '../api/sessionsd';
import {
  getNativeConnectionSettings,
  isTauri,
  runNativeConnectionAction,
  setNativeRuntimePort,
  type NativeConnectionSettings
} from '../lib/tauriBridge';
import { configureNativeLocalPort } from '../lib/servers';
import { SomewhereCard } from './SomewhereCard';

interface RemoteState {
  enabled: boolean;
  verified: boolean;
  endpoint?: string;
  target?: string | null;
  connectUrl?: string;
}

interface PairState {
  url: string;
  endpoint: string;
  ticket: string;
  expires_at: string;
}

export function ConnectionsView(): JSX.Element {
  const [native, setNative] = useState<NativeConnectionSettings | null>(null);
  const [port, setPort] = useState('8787');
  const [lan, setLAN] = useState<LANState | null>(null);
  const [remote, setRemote] = useState<RemoteState | null>(null);
  const [remoteError, setRemoteError] = useState<string | null>(null);
  const [pair, setPair] = useState<PairState | null>(null);
  const [pairName, setPairName] = useState('My phone');
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const refresh = useCallback(async (): Promise<void> => {
    setMessage(null);
    const lanRequest = isTauri()
      ? runNativeConnectionAction<LANState>('lan', 'status').then((result) => result.data)
      : fetchLANState();
    const [nativeResult, lanResult] = await Promise.all([
      getNativeConnectionSettings().catch(() => null),
      lanRequest.catch(() => null)
    ]);
    setNative(nativeResult);
    if (nativeResult) setPort(String(nativeResult.port));
    setLAN(lanResult);
    if (!isTauri()) return;
    try {
      const status = await runNativeConnectionAction<RemoteState>('remote', 'status');
      setRemote(status.data);
      setRemoteError(null);
    } catch (reason) {
      setRemote(null);
      setRemoteError(reason instanceof Error ? reason.message : String(reason));
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  const changeLAN = async (enabled: boolean): Promise<void> => {
    if (busy) return;
    setBusy('lan'); setMessage(null);
    try {
      if (isTauri()) {
        const result = await runNativeConnectionAction<LANState & { verified?: boolean }>('lan', enabled ? 'enable' : 'disable');
        setLAN({ enabled: result.data.enabled, url: result.data.url ?? null });
      } else {
        setLAN(await setLANEnabled(enabled));
      }
    } catch (reason) {
      setMessage(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(null);
    }
  };

  const changeRemote = async (enabled: boolean): Promise<void> => {
    if (busy || !isTauri()) return;
    setBusy('remote'); setMessage(null); setPair(null);
    try {
      const result = await runNativeConnectionAction<RemoteState>('remote', enabled ? 'enable' : 'disable');
      setRemote(result.data);
      setRemoteError(null);
      if (result.detail) setMessage(result.detail);
    } catch (reason) {
      const detail = reason instanceof Error ? reason.message : String(reason);
      setRemoteError(detail); setMessage(detail);
    } finally {
      setBusy(null);
    }
  };

  const createPair = async (): Promise<void> => {
    if (busy || !isTauri()) return;
    setBusy('pair'); setMessage(null);
    try {
      const result = await runNativeConnectionAction<PairState>('pair', 'create', pairName);
      setPair(result.data);
    } catch (reason) {
      setMessage(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(null);
    }
  };

  const savePort = async (): Promise<void> => {
    if (busy || !native) return;
    const requested = Number(port);
    if (!Number.isInteger(requested) || requested < 1024 || requested > 65535) {
      setMessage('Choose a port between 1024 and 65535.');
      return;
    }
    if (requested === native.port) return;
    setBusy('port'); setMessage('Moving the background service safely…');
    try {
      const next = await setNativeRuntimePort(requested);
      setNative(next);
      configureNativeLocalPort(next.port);
      setMessage(`Sessions moved to localhost:${next.port}. Reconnecting the app…`);
      window.setTimeout(() => window.location.reload(), 650);
    } catch (reason) {
      setPort(String(native.port));
      setMessage(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="connections-view">
      <div className="connections-shell">
        <header className="connections-heading">
          <div><span>Private by default</span><h1>Connections</h1><p>Your Mac is the server. Sessions never relays terminal traffic.</p></div>
          <button type="button" className="btn btn-ghost" disabled={busy !== null} onClick={() => void refresh()}>Refresh status</button>
        </header>

        {message ? <div className="connections-message" role="status">{message}</div> : null}

        <section className="connection-ladder" aria-label="Connection options">
          <ConnectionCard step="01" title="This Mac" state="Always private" active>
            <p>Sessions.app talks to the independent loopback daemon. Quitting the app never stops its sessions.</p>
            <div className="connection-endpoint">http://localhost:{native?.port ?? port}</div>
            <details className="connection-advanced">
              <summary>Advanced port</summary>
              <p>Changing this restarts only the daemon, verifies every runner is re-adopted, and rolls back on failure.</p>
              <div className="connection-inline">
                <input type="number" min={1024} max={65535} value={port} onChange={(event) => setPort(event.currentTarget.value)} disabled={!native || native.runtime.state !== 'ready' || busy !== null} />
                <button type="button" className="btn" disabled={!native || native.runtime.state !== 'ready' || busy !== null || Number(port) === native.port} onClick={() => void savePort()}>{busy === 'port' ? 'Moving…' : 'Change port'}</button>
              </div>
              {native?.runtime.state === 'development' ? <small>Installed-app only. Development builds use the separately managed dev daemon.</small> : null}
            </details>
          </ConnectionCard>

          <ConnectionCard step="02" title="Same Wi-Fi" state={lan?.enabled ? 'On' : 'Off'} active={lan?.enabled === true}>
            <p>Open the same Sessions GUI from Chrome or a phone on this local network. A device token is still required.</p>
            {lan?.url ? <div className="connection-endpoint">{lan.url}</div> : null}
            <button type="button" className={`btn${lan?.enabled ? ' btn-ghost' : ''}`} disabled={busy !== null} onClick={() => void changeLAN(!lan?.enabled)}>{busy === 'lan' ? 'Checking…' : lan?.enabled ? 'Turn off LAN' : 'Enable LAN access'}</button>
          </ConnectionCard>

          <ConnectionCard step="03" title="Anywhere" state={remote?.enabled && remote.verified ? 'Tailscale HTTPS on' : 'Off'} active={remote?.enabled === true && remote.verified === true}>
            <p>Tailscale Serve keeps the connection inside your tailnet with HTTPS terminating on this Mac. Sessions operates no relay.</p>
            {remote?.endpoint ? <div className="connection-endpoint">{remote.endpoint}</div> : null}
            {remoteError ? <div className="connection-error">{remoteError}</div> : null}
            {!remote?.enabled ? <div className="connection-privacy-note"><strong>Before enabling</strong><span>Tailscale issues a public certificate, so the machine’s <code>.ts.net</code> name appears in Certificate Transparency logs.</span></div> : null}
            <div className="connection-actions">
              <button type="button" className={`btn${remote?.enabled ? ' btn-ghost' : ''}`} disabled={!isTauri() || busy !== null} onClick={() => void changeRemote(!remote?.enabled)}>{busy === 'remote' ? 'Verifying…' : remote?.enabled ? 'Disable remote access' : 'Enable Tailscale HTTPS'}</button>
              {remoteError?.toLowerCase().includes('not installed') ? <a className="btn btn-ghost" href="https://tailscale.com/download" target="_blank" rel="noreferrer">Get Tailscale</a> : null}
            </div>
          </ConnectionCard>
        </section>

        <section className="pair-device-card">
          <div><span className="connections-section-kicker">Five minutes · single use</span><h2>Pair a phone or browser</h2><p>The device receives its own revocable credential. Your master daemon token never appears in the link.</p></div>
          <div className="pair-device-controls">
            <input value={pairName} maxLength={80} onChange={(event) => setPairName(event.currentTarget.value)} placeholder="Device name" />
            <button type="button" className="btn" disabled={!isTauri() || busy !== null || (!lan?.enabled && !remote?.enabled)} onClick={() => void createPair()}>{busy === 'pair' ? 'Creating…' : 'Create pairing link'}</button>
          </div>
          {pair ? (
            <div className="pair-result">
              <div><strong>Pairing link ready</strong><span>Expires {new Date(pair.expires_at).toLocaleTimeString()}</span></div>
              <code>{pair.url}</code>
              <div className="connection-actions">
                <button type="button" className="btn" onClick={() => void navigator.clipboard.writeText(pair.url).then(() => setMessage('Pairing link copied.'))}>Copy link</button>
                <a className="btn btn-ghost" href={pair.url} target="_blank" rel="noreferrer">Open link</a>
              </div>
            </div>
          ) : null}
        </section>

        <SomewhereCard />
      </div>
    </div>
  );
}

function ConnectionCard({ step, title, state, active = false, children }: { step: string; title: string; state: string; active?: boolean; children: ReactNode }): JSX.Element {
  return (
    <article className={`connection-card${active ? ' is-active' : ''}`}>
      <header><span>{step}</span><h2>{title}</h2><strong>{state}</strong></header>
      <div className="connection-card-body">{children}</div>
    </article>
  );
}
