import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { fetchServerHealth } from '../api/sessionsd';
import { rememberNativeMachineClaim, rememberServerEndpoint } from '../lib/hostedBootstrap';
import { formatServerEndpoint } from '../lib/serverEndpoint';
import { useServers, type ServerConfig } from '../lib/servers';
import { tailnetClientID } from '../lib/tailnetClient';
import {
  claimNativeTailnetAccess,
  discoverNativeTailnetPeers,
  requestNativeTailnetAccess,
  type NativeTailnetPeer,
  type NativeTailnetRequest
} from '../lib/tauriBridge';

const LOCAL_ENDPOINT = 'http://localhost:8787';
const HEALTH_TIMEOUT_MS = 8_000;

interface ConnectScreenProps {
  clientOnly?: boolean;
  localDaemonUnavailable?: boolean;
  detail?: string;
  onRetry?: () => void;
}

export function ConnectScreen({
  clientOnly = false,
  localDaemonUnavailable = false,
  detail,
  onRetry
}: ConnectScreenProps = {}): JSX.Element {
  const servers = useServers((state) => state.servers);
  const setActive = useServers((state) => state.setActive);
  const removeServer = useServers((state) => state.removeServer);
  const pairingError = useServers((state) => state.pairingError);
  const setPairingError = useServers((state) => state.setPairingError);
  const [name, setName] = useState('');
  const [endpoint, setEndpoint] = useState('');
  const [token, setToken] = useState('');
  const [checkingId, setCheckingId] = useState<string | null>(null);
  const [discoveryBusy, setDiscoveryBusy] = useState(false);
  const [discoveredPeers, setDiscoveredPeers] = useState<NativeTailnetPeer[] | null>(null);
  const [accessRequest, setAccessRequest] = useState<NativeTailnetRequest | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const busy = checkingId !== null || discoveryBusy || accessRequest !== null;
  const remembered = useMemo(
    () => servers.filter((server) => !server.isDefault),
    [servers]
  );

  const findMachines = async (): Promise<void> => {
    if (!clientOnly || busy) return;
    setDiscoveryBusy(true);
    setMessage('Looking for Sessions machines on your tailnet…');
    setError(null);
    try {
      const peers = await discoverNativeTailnetPeers();
      setDiscoveredPeers(peers);
      setMessage(peers.length > 0
        ? `Found ${peers.length} ${peers.length === 1 ? 'machine' : 'machines'}.`
        : 'No Sessions machines answered. Make sure Tailscale and remote access are on at the host.');
    } catch (reason) {
      setDiscoveredPeers([]);
      setMessage(null);
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setDiscoveryBusy(false);
    }
  };

  const requestAccess = async (peer: NativeTailnetPeer): Promise<void> => {
    if (!clientOnly || busy) return;
    setDiscoveryBusy(true);
    setError(null);
    try {
      const request = await requestNativeTailnetAccess(peer.endpoint, tailnetClientID(), '');
      setAccessRequest(request);
      setMessage(`Request sent to ${peer.hostname}. Accept it in Sessions on that machine.`);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setDiscoveryBusy(false);
    }
  };

  useEffect(() => {
    if (!accessRequest) return;
    let cancelled = false;
    let checking = false;
    const check = async (): Promise<void> => {
      if (checking) return;
      checking = true;
      try {
        const result = await claimNativeTailnetAccess(accessRequest);
        if (cancelled || result.status === 'pending') return;
        if (result.status === 'accepted' && result.claim) {
          const server = await rememberNativeMachineClaim(result.claim);
          if (!cancelled) {
            setAccessRequest(null);
            setMessage(`${server.name} approved this device. Connecting…`);
          }
          return;
        }
        if (!cancelled) {
          setAccessRequest(null);
          setMessage(null);
          setError(result.status === 'denied'
            ? 'The other machine denied this request.'
            : 'The request expired. Search again when someone is at the other machine.');
        }
      } catch (reason) {
        if (!cancelled) setError(reason instanceof Error ? reason.message : String(reason));
      } finally {
        checking = false;
      }
    };
    void check();
    const interval = window.setInterval(() => { void check(); }, 2_000);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [accessRequest]);

  if (localDaemonUnavailable) {
    return (
      <main className="connect-screen" data-testid="connect-screen">
        <section className="connect-panel" aria-labelledby="connect-title">
          <div className="connect-brand">Sessions</div>
          <p className="connect-kicker">native window → local daemon</p>
          <h1 id="connect-title">Sessions isn&apos;t running yet.</h1>
          <p className="connect-lede">
            The app is only a window onto the local background service. Your sessions
            stay separate from the app and keep running when you quit it.
          </p>
          <section className="connect-setup" aria-labelledby="setup-title">
            <h2 id="setup-title">Background service</h2>
            <ol>
              <li>
                <span>Sessions installs and starts its signed local runtime automatically.</span>
                <code>~/Library/Logs/Sessions/sessionsd.log</code>
              </li>
            </ol>
          </section>
          {detail ? <p className="connect-error" role="alert">{detail}</p> : null}
          <button type="button" className="connect-submit" onClick={onRetry}>
            Try again
          </button>
        </section>
      </main>
    );
  }

  const probe = async (server: ServerConfig): Promise<void> => {
    setPairingError(null);
    setCheckingId(server.id);
    setMessage(`Checking ${formatServerEndpoint(server)}…`);
    setError(null);
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), HEALTH_TIMEOUT_MS);
    try {
      await fetchServerHealth(server, controller.signal);
      setActive(server.id);
      onRetry?.();
    } catch (probeError) {
      const detail = probeError instanceof Error && probeError.name !== 'AbortError'
        ? probeError.message
        : 'The endpoint did not answer within 8 seconds.';
      setMessage(null);
      setError(`${detail} Check Tailscale, then run sessions doctor on the daemon host.`);
    } finally {
      window.clearTimeout(timeout);
      setCheckingId(null);
    }
  };

  const addAndProbe = async (
    endpointValue: string,
    options: { name?: string; token?: string } = {}
  ): Promise<void> => {
    setPairingError(null);
    setError(null);
    let server: ServerConfig;
    try {
      server = rememberServerEndpoint(endpointValue, {
        name: options.name,
        token: options.token,
        select: false
      });
    } catch (validationError) {
      setError(validationError instanceof Error ? validationError.message : 'Enter a valid endpoint.');
      return;
    }
    await probe(server);
  };

  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (busy) return;
    void addAndProbe(endpoint, { name, token });
  };

  return (
    <main className="connect-screen" data-testid="connect-screen">
      <section className="connect-panel" aria-labelledby="connect-title">
        <div className="connect-brand">Sessions</div>
        <p className="connect-kicker">
          {clientOnly ? 'this device → your Sessions machines' : 'native window → your daemon'}
        </p>
        <h1 id="connect-title">
          {clientOnly ? 'Find the computers running your sessions.' : 'Open your sessions from here.'}
        </h1>
        <p className="connect-lede">
          {clientOnly
            ? 'Sessions connects directly over your private network. The computer running each agent stays in control, and approves this device before anything opens.'
            : 'This is the complete Sessions app. Pick a daemon and this client talks straight to it — no relay, proxy, hosted terminal data, or analytics.'}
        </p>

        {clientOnly ? (
          <section className="connect-discovery" aria-labelledby="discovery-title">
            <div className="connect-discovery-heading">
              <div>
                <span>Private machine discovery</span>
                <h2 id="discovery-title">Find with Tailscale</h2>
                <p>Sessions checks devices already in your tailnet and shows only verified Sessions runtimes.</p>
              </div>
              <button type="button" className="connect-submit connect-find" disabled={busy} onClick={() => void findMachines()}>
                {discoveryBusy ? 'Searching…' : discoveredPeers === null ? 'Find machines' : 'Search again'}
              </button>
            </div>
            {discoveredPeers !== null && discoveredPeers.length > 0 ? (
              <div className="connect-peer-list">
                {discoveredPeers.map((peer) => {
                  const waiting = accessRequest?.endpoint === peer.endpoint;
                  return (
                    <article key={peer.endpoint} className="connect-peer">
                      <span className="connect-peer-icon" aria-hidden>{peer.os.toLowerCase().includes('windows') ? '⊞' : peer.os.toLowerCase().includes('mac') ? '⌘' : '◇'}</span>
                      <div>
                        <strong>{peer.hostname}</strong>
                        <small>{peer.endpoint.replace('https://', '')}</small>
                      </div>
                      <button type="button" className="btn" disabled={busy} onClick={() => void requestAccess(peer)}>
                        {waiting ? 'Waiting for approval…' : 'Request access'}
                      </button>
                    </article>
                  );
                })}
              </div>
            ) : null}
          </section>
        ) : null}

        {remembered.length > 0 ? (
          <section className="connect-remembered" aria-labelledby="remembered-title">
            <h2 id="remembered-title">Remembered servers</h2>
            <div className="connect-server-list">
              {remembered.map((server) => (
                <div className="connect-server-row" key={server.id}>
                  <button
                    type="button"
                    className="connect-server-pick"
                    disabled={busy}
                    onClick={() => void probe(server)}
                  >
                    <span className="connect-server-name">{server.name}</span>
                    <span className="connect-server-endpoint">{formatServerEndpoint(server)}</span>
                    <span aria-hidden>{checkingId === server.id ? 'checking…' : 'connect →'}</span>
                  </button>
                  <button
                    type="button"
                    className="connect-server-remove"
                    disabled={busy}
                    aria-label={`Forget ${server.name}`}
                    onClick={() => removeServer(server.id)}
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>
          </section>
        ) : null}

        <div className="connect-actions">
          {!clientOnly ? (
            <button
              type="button"
              className="connect-local-button"
              disabled={busy}
              onClick={() => void addAndProbe(LOCAL_ENDPOINT, { name: 'This machine' })}
            >
              <span className="connect-local-icon" aria-hidden>⌁</span>
              <span>
                <strong>Connect on this device</strong>
                <small>{LOCAL_ENDPOINT}</small>
              </span>
              <span aria-hidden>→</span>
            </button>
          ) : null}

          <div className="connect-divider">
            <span>{clientOnly ? 'or enter connection details' : 'or add a server'}</span>
          </div>

          <form className="connect-form" onSubmit={submit}>
            <label>
              <span>Name <small>optional</small></span>
              <input
                type="text"
                autoComplete="off"
                placeholder="Studio Mac"
                value={name}
                onChange={(event) => setName(event.currentTarget.value)}
              />
            </label>
            <label>
              <span>Endpoint</span>
              <input
                type="url"
                inputMode="url"
                autoComplete="url"
                placeholder="https://mac.example.ts.net"
                required
                value={endpoint}
                onChange={(event) => setEndpoint(event.currentTarget.value)}
              />
            </label>
            <label>
              <span>Token <small>from the connect link</small></span>
              <input
                type="password"
                autoComplete="off"
                placeholder="Optional on localhost"
                value={token}
                onChange={(event) => setToken(event.currentTarget.value)}
              />
            </label>
            <button type="submit" className="connect-submit" disabled={busy || !endpoint.trim()}>
              {busy ? 'Checking daemon…' : 'Connect to Sessions'}
            </button>
          </form>
        </div>

        {message ? <p className="connect-status" role="status">{message}</p> : null}
        {error || pairingError || detail ? (
          <p className="connect-error" role="alert">{error ?? pairingError ?? detail}</p>
        ) : null}

        <section className="connect-setup" aria-labelledby="setup-title">
          <h2 id="setup-title">First time?</h2>
          <ol>
            <li>
              <span>Install and start Sessions on the Mac that owns your sessions.</span>
              <code>brew install somewhere-tech/tap/sessions &amp;&amp; sessions install</code>
            </li>
            <li>
              <span>Enable direct HTTPS access over your own Tailscale network.</span>
              <code>sessions remote enable</code>
            </li>
            <li>
              <span>
                {clientOnly
                  ? 'Click Find machines here, then accept the request in Sessions on the Mac.'
                  : 'Scan the printed QR code, or paste its endpoint and token above.'}
              </span>
            </li>
          </ol>
        </section>

        <p className="connect-privacy">
          Endpoint and revocable device token stay in this app&apos;s local storage.
          URL-fragment connect links are scrubbed before the app starts.
        </p>
      </section>
    </main>
  );
}
