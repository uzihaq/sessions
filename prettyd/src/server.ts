import { createServer } from 'node:http';
import { config } from './config.js';
import { handleHttp } from './http.js';
import { handleUpgrade } from './ws.js';
import { discoverRunners } from './sessions.js';

// Hard reject any-interface binding. 0.0.0.0 / :: would expose prettyd
// on every network the host has — coffee shop WiFi, home LAN, anything a
// future port-forward could reach. There is NO override flag for this:
// for tailnet access, set PRETTYD_HOST to a specific tailnet IP (e.g.
// 100.x.y.z) so prettyd binds only on the Tailscale interface, which
// already provides authentication and encryption.
const ANY_HOSTS = new Set(['0.0.0.0', '::', '::0', '*']);
if (ANY_HOSTS.has(config.host)) {
  console.error(
    `\n  prettyd: refusing to bind to ${config.host}.\n` +
    `  Set PRETTYD_HOST to a specific address — 127.0.0.1 for loopback only,\n` +
    `  or a tailnet IP (100.x.y.z) for access from other devices on your tailnet.\n`
  );
  process.exit(2);
}

const server = createServer((req, res) => {
  handleHttp(req, res).catch((err) => {
    res.statusCode = 500;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: (err as Error).message }));
  });
});

server.on('upgrade', handleUpgrade);

(async () => {
  // Reattach to any runners that survived the previous prettyd lifetime
  // (typical case: tsx-watch hot reload on code edit). Each one is a
  // detached child process with its own Unix socket; we reconnect, pull
  // its current event log into the local mirror, and serve it as if it
  // had been here all along.
  try {
    await discoverRunners();
  } catch (err) {
    console.error('runner discovery failed:', (err as Error).message);
  }
  server.listen(config.port, config.host, () => {
    const isLocal = config.host === '127.0.0.1' || config.host === '::1' || config.host === 'localhost';
    console.log(`prettyd listening on http://${config.host}:${config.port}`);
    if (!isLocal) {
      console.log(`  warning: bound to non-local interface; prefer loopback + frontend proxy for phone use`);
    }
  });
})();

const shutdown = (sig: string): void => {
  console.log(`prettyd: ${sig} received, shutting down`);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 2000).unref();
};
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
