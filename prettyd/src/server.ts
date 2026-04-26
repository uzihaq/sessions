import { createServer } from 'node:http';
import { config } from './config.js';
import { handleHttp } from './http.js';
import { handleUpgrade } from './ws.js';

const server = createServer((req, res) => {
  handleHttp(req, res).catch((err) => {
    res.statusCode = 500;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: (err as Error).message }));
  });
});

server.on('upgrade', handleUpgrade);

server.listen(config.port, config.host, () => {
  console.log(`prettyd listening on http://${config.host}:${config.port}`);
});

const shutdown = (sig: string): void => {
  console.log(`prettyd: ${sig} received, shutting down`);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 2000).unref();
};
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
