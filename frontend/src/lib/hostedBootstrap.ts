import {
  adoptCurrentOriginServer,
  useServers,
  type ServerConfig
} from './servers';
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

interface PairClaimResponse {
  device_id: string;
  token: string;
  name: string;
}

function pairingTicket(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return '';
  try {
    const parsed = new URL(trimmed, window.location.origin);
    const fromFragment = new URLSearchParams(parsed.hash.slice(1)).get('pair');
    if (fromFragment) return fromFragment.trim();
  } catch {
    // A bare ticket is the normal Settings input; return it unchanged.
  }
  if (trimmed.startsWith('#')) {
    return new URLSearchParams(trimmed.slice(1)).get('pair')?.trim() ?? '';
  }
  return trimmed;
}

function pairClaimError(status: number, body: unknown): Error {
  if (typeof body === 'object' && body !== null) {
    const error = (body as Record<string, unknown>).error;
    if (typeof error === 'string' && error.trim()) return new Error(error.trim());
  }
  return new Error(`Pairing failed (HTTP ${status}). Run pretty pair again.`);
}

// Claim only against the page's own daemon origin. Pairing tickets are never
// sent to a configured cross-origin server or to the hosted app shell.
export async function claimCurrentOriginPairing(
  ticketValue: string,
  name?: string
): Promise<PairClaimResponse> {
  const ticket = pairingTicket(ticketValue);
  if (!ticket) throw new Error('Paste a pairing ticket from `pretty pair`.');

  const response = await fetch(`${window.location.origin}/api/pair/claim`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ticket, ...(name?.trim() ? { name: name.trim() } : {}) })
  });
  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    // The status-specific fallback below remains instructional.
  }
  if (!response.ok) throw pairClaimError(response.status, body);
  if (typeof body !== 'object' || body === null) {
    throw new Error('Pairing succeeded without a device credential. Run `pretty pair` again.');
  }
  const claimed = body as Partial<PairClaimResponse>;
  if (!claimed.device_id || !claimed.token || !claimed.name) {
    throw new Error('Pairing succeeded with an invalid device credential. Run `pretty pair` again.');
  }

  adoptCurrentOriginServer(claimed.token);
  return claimed as PairClaimResponse;
}

// Run before every other bootstrap. The fragment is scrubbed before the
// network request so even an expired or malformed ticket never stays visible.
export async function bootstrapPairingConnection(): Promise<boolean> {
  if (typeof window === 'undefined' || !window.location.hash) return false;
  const params = new URLSearchParams(window.location.hash.slice(1));
  if (!params.has('pair')) return false;

  const ticket = params.get('pair') ?? '';
  scrubFragment();
  try {
    await claimCurrentOriginPairing(ticket);
  } catch (error) {
    const detail = error instanceof Error ? error.message : 'Pairing failed. Run `pretty pair` again.';
    const store = useServers.getState();
    store.setPairingError(detail);
    store.setActive(null);
  }
  return true;
}
