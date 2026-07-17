import { useServers, type ServerConfig } from './servers';
import { isLoopbackHost, parseServerEndpoint } from './serverEndpoint';

function matchesEndpoint(
  server: ServerConfig,
  endpoint: ReturnType<typeof parseServerEndpoint>
): boolean {
  return (server.scheme ?? 'http') === endpoint.scheme
    && server.host.toLowerCase() === endpoint.host
    && server.port === endpoint.port;
}

function scrubFragment(): void {
  window.history.replaceState(
    window.history.state,
    '',
    `${window.location.pathname}${window.location.search}`
  );
}

interface RememberServerOptions {
  name?: string;
  token?: string | null;
  select?: boolean;
}

// Shared first-run/add-server path. Hosted browser connections require TLS,
// with loopback HTTP as the deliberate exception for a daemon on the device
// running the browser. The endpoint is upserted so rescanning a QR link never
// creates duplicates.
export function rememberServerEndpoint(
  endpointValue: string,
  options: RememberServerOptions = {}
): ServerConfig {
  const endpoint = parseServerEndpoint(endpointValue);
  if (endpoint.scheme === 'http' && !isLoopbackHost(endpoint.host)) {
    throw new Error('Use HTTPS for remote servers. HTTP is allowed only on localhost.');
  }

  const store = useServers.getState();
  const existing = store.servers.find((server) => matchesEndpoint(server, endpoint));
  const tokenUpdate = options.token === undefined
    ? {}
    : { token: options.token?.trim() || undefined };
  const name = options.name?.trim();

  if (existing) {
    store.updateServer(existing.id, {
      ...endpoint,
      ...tokenUpdate,
      ...(name ? { name } : {})
    });
    if (options.select !== false) store.setActive(existing.id);
    return useServers.getState().servers.find((server) => server.id === existing.id) ?? existing;
  }

  const created = store.addServer({
    name: name || endpoint.host,
    ...endpoint,
    ...tokenUpdate
  });
  if (options.select !== false) store.setActive(created.id);
  return created;
}

// Hosted connection links have the form:
//   #endpoint=https%3A%2F%2Fmac.example.com&token=secret
//
// Run once before React mounts. The hash is scrubbed before parsing or
// touching storage so a token never remains visible if validation fails.
export function bootstrapHostedConnection(): void {
  if (typeof window === 'undefined' || !window.location.hash) return;

  const params = new URLSearchParams(window.location.hash.slice(1));
  if (!params.has('endpoint')) return;

  const endpointValue = params.get('endpoint') ?? '';
  const tokenValue = params.get('token');
  scrubFragment();

  try {
    rememberServerEndpoint(endpointValue, { token: tokenValue });
  } catch {
    return;
  }
}
