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

  let endpoint: ReturnType<typeof parseServerEndpoint>;
  try {
    endpoint = parseServerEndpoint(endpointValue);
  } catch {
    return;
  }

  // Hosted bootstrap links may only cross the network over TLS. Loopback
  // HTTP remains available for local development and installed local apps.
  if (endpoint.scheme === 'http' && !isLoopbackHost(endpoint.host)) return;

  const store = useServers.getState();
  const existing = store.servers.find((server) => matchesEndpoint(server, endpoint));
  const tokenUpdate = tokenValue === null
    ? {}
    : { token: tokenValue.trim() || undefined };

  if (existing) {
    store.updateServer(existing.id, { ...endpoint, ...tokenUpdate });
    store.setActive(existing.id);
    return;
  }

  const created = store.addServer({
    name: endpoint.host,
    ...endpoint,
    ...tokenUpdate
  });
  store.setActive(created.id);
}
