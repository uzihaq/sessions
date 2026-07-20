import { useMemo, useState, type FormEvent } from 'react';
import { fetchServerHealth } from '../api/prettyd';
import { rememberServerEndpoint } from '../lib/hostedBootstrap';
import { formatServerEndpoint } from '../lib/serverEndpoint';
import { useServers, type ServerConfig } from '../lib/servers';

const LOCAL_ENDPOINT = 'http://localhost:8787';
const HEALTH_TIMEOUT_MS = 8_000;

interface ConnectScreenProps {
  localDaemonUnavailable?: boolean;
  detail?: string;
  onRetry?: () => void;
}

export function ConnectScreen({
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
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const busy = checkingId !== null;
  const remembered = useMemo(
    () => servers.filter((server) => !server.isDefault),
    [servers]
  );

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
                <code>~/Library/Logs/Sessions/prettyd.log</code>
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
    } catch (probeError) {
      const detail = probeError instanceof Error && probeError.name !== 'AbortError'
        ? probeError.message
        : 'The endpoint did not answer within 8 seconds.';
      setMessage(null);
      setError(`${detail} Check Tailscale, then run pretty doctor on the daemon host.`);
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
        <p className="connect-kicker">your browser → your daemon</p>
        <h1 id="connect-title">Open your sessions from here.</h1>
        <p className="connect-lede">
          This is the complete Sessions app. Pick a daemon and this browser talks
          straight to it — no relay, proxy, hosted terminal data, or analytics.
        </p>

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

          <div className="connect-divider"><span>or add a server</span></div>

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
        {error || pairingError ? (
          <p className="connect-error" role="alert">{error ?? pairingError}</p>
        ) : null}

        <section className="connect-setup" aria-labelledby="setup-title">
          <h2 id="setup-title">First time?</h2>
          <ol>
            <li>
              <span>Install and start Sessions on the Mac that owns your sessions.</span>
              <code>brew install uzihaq/tap/pretty &amp;&amp; pretty install</code>
            </li>
            <li>
              <span>Enable direct HTTPS access over your own Tailscale network.</span>
              <code>pretty remote enable</code>
            </li>
            <li>
              <span>Scan the printed QR code, or paste its endpoint and token above.</span>
            </li>
          </ol>
        </section>

        <p className="connect-privacy">
          Endpoint and token stay in this browser’s local storage. URL-fragment
          connect links are scrubbed before the app starts.
        </p>
      </section>
    </main>
  );
}
