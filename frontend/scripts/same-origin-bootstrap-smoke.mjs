import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';

const frontendDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const distDir = path.join(frontendDir, 'dist');
if (!fs.existsSync(path.join(distDir, 'index.html'))) {
  throw new Error('frontend/dist is missing; run npx vite build first');
}

const contentTypes = new Map([
  ['.css', 'text/css; charset=utf-8'],
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.png', 'image/png'],
  ['.svg', 'image/svg+xml'],
  ['.woff2', 'font/woff2']
]);

const server = http.createServer((request, response) => {
  const pathname = decodeURIComponent(new URL(request.url ?? '/', 'http://localhost').pathname);
  const relativePath = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const filePath = path.resolve(distDir, relativePath);
  if (!filePath.startsWith(`${distDir}${path.sep}`) || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    response.writeHead(404).end('not found');
    return;
  }
  response.writeHead(200, {
    'content-type': contentTypes.get(path.extname(filePath)) ?? 'application/octet-stream'
  });
  fs.createReadStream(filePath).pipe(response);
});

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const address = server.address();
if (!address || typeof address === 'string') throw new Error('failed to bind smoke server');
assert.notEqual(address.port, 8787, 'smoke server must exercise a non-8787 origin');
const origin = `http://127.0.0.1:${address.port}`;

const browser = await puppeteer.launch({
  headless: true,
  args: ['--no-sandbox', '--disable-dev-shm-usage']
});

async function openCase(health) {
  const page = await browser.newPage();
  await page.setBypassServiceWorker(true);
  await page.evaluateOnNewDocument(() => window.localStorage.clear());

  let healthRequests = 0;
  let sessionsRequests = 0;
  let sessionsUnauthorized = false;
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.setRequestInterception(true);
  page.on('request', (request) => {
    const url = request.url();
    if (url === `${origin}/api/health`) {
      healthRequests += 1;
      if (health === 'reject') {
        void request.abort('failed');
      } else {
        const status = health === 'unauthorized' ? 401 : 200;
        const body = status === 200 ? JSON.stringify({ name: 'prettyd' }) : '';
        void request.respond({ status, contentType: 'application/json', body });
      }
      return;
    }
    if (url === `${origin}/api/sessions`) {
      sessionsRequests += 1;
      const status = sessionsUnauthorized ? 401 : 200;
      const body = status === 200 ? JSON.stringify({ sessions: [] }) : '';
      void request.respond({ status, contentType: 'application/json', body });
      return;
    }
    void request.continue();
  });

  return {
    page,
    pageErrors,
    get healthRequests() { return healthRequests; },
    get sessionsRequests() { return sessionsRequests; },
    requireSessionsToken() { sessionsUnauthorized = true; }
  };
}

try {
  const healthy = await openCase('healthy');
  await healthy.page.goto(origin, { waitUntil: 'domcontentloaded', timeout: 15_000 });
  await healthy.page.waitForSelector('.app-shell', { timeout: 10_000 });
  await healthy.page.waitForFunction(() => {
    const servers = JSON.parse(window.localStorage.getItem('pretty-pty:servers') ?? '[]');
    return servers.length === 1 && window.localStorage.getItem('pretty-pty:active-server') === servers[0].id;
  });
  const healthyState = await healthy.page.evaluate(() => ({
    pickerVisible: document.querySelector('[data-testid="connect-screen"]') !== null,
    servers: JSON.parse(window.localStorage.getItem('pretty-pty:servers') ?? '[]'),
    activeId: window.localStorage.getItem('pretty-pty:active-server')
  }));
  assert.equal(healthyState.pickerVisible, false);
  assert.deepEqual(healthyState.servers[0], {
    id: 'local',
    name: 'This machine',
    host: '127.0.0.1',
    port: address.port,
    isDefault: true,
    scheme: 'http'
  });
  assert.equal(healthyState.activeId, 'local');

  await healthy.page.waitForFunction(() => document.querySelector('.empty-state') !== null);
  healthy.requireSessionsToken();
  await healthy.page.waitForSelector('.daemon-banner-token-input', { timeout: 6_000 });
  const runtimePrompt = await healthy.page.$eval(
    '.daemon-banner-host',
    (node) => node.textContent?.trim() ?? ''
  );
  assert.equal(runtimePrompt, origin);
  assert.deepEqual(healthy.pageErrors, []);
  await healthy.page.close();

  const unauthorized = await openCase('unauthorized');
  await unauthorized.page.goto(origin, { waitUntil: 'domcontentloaded', timeout: 15_000 });
  await unauthorized.page.waitForSelector('.daemon-banner-token-input', { timeout: 10_000 });
  const unauthorizedState = await unauthorized.page.evaluate(() => ({
    endpoint: document.querySelector('.daemon-banner-host')?.textContent?.trim() ?? '',
    tokenFocused: document.activeElement?.classList.contains('daemon-banner-token-input') ?? false,
    servers: JSON.parse(window.localStorage.getItem('pretty-pty:servers') ?? '[]')
  }));
  assert.equal(unauthorizedState.endpoint, origin);
  assert.equal(unauthorizedState.tokenFocused, true);
  assert.equal(unauthorizedState.servers[0]?.id, 'local');
  assert.deepEqual(unauthorized.pageErrors, []);
  await unauthorized.page.close();

  const rejected = await openCase('reject');
  await rejected.page.goto(origin, { waitUntil: 'domcontentloaded', timeout: 15_000 });
  await rejected.page.waitForSelector('[data-testid="connect-screen"]', { timeout: 10_000 });
  const rejectedState = await rejected.page.evaluate(() => ({
    servers: JSON.parse(window.localStorage.getItem('pretty-pty:servers') ?? '[]'),
    activeId: window.localStorage.getItem('pretty-pty:active-server')
  }));
  assert.deepEqual(rejectedState, { servers: [], activeId: null });
  assert.deepEqual(rejected.pageErrors, []);
  await rejected.page.close();

  const fragment = await openCase('healthy');
  const fragmentUrl = `${origin}/#endpoint=${encodeURIComponent(origin)}&token=fragment-smoke-token`;
  await fragment.page.goto(fragmentUrl, { waitUntil: 'domcontentloaded', timeout: 15_000 });
  await fragment.page.waitForSelector('.app-shell', { timeout: 10_000 });
  const fragmentState = await fragment.page.evaluate(() => ({
    hash: window.location.hash,
    servers: JSON.parse(window.localStorage.getItem('pretty-pty:servers') ?? '[]'),
    activeId: window.localStorage.getItem('pretty-pty:active-server')
  }));
  assert.equal(fragment.healthRequests, 0);
  assert.equal(fragmentState.hash, '');
  assert.equal(fragmentState.servers.length, 1);
  assert.equal(fragmentState.servers[0].token, 'fragment-smoke-token');
  assert.equal(fragmentState.servers[0].isDefault, false);
  assert.equal(fragmentState.activeId, fragmentState.servers[0].id);
  assert.deepEqual(fragment.pageErrors, []);
  await fragment.page.close();

  console.log(JSON.stringify({
    origin,
    healthy: {
      healthRequests: healthy.healthRequests,
      autoSelected: healthyState.activeId === 'local',
      pickerVisible: healthyState.pickerVisible,
      runtime401Prompt: runtimePrompt
    },
    unauthorized: {
      healthRequests: unauthorized.healthRequests,
      endpoint: unauthorizedState.endpoint,
      tokenFocused: unauthorizedState.tokenFocused
    },
    rejected: {
      healthRequests: rejected.healthRequests,
      pickerVisible: true,
      serverCount: rejectedState.servers.length
    },
    fragment: {
      healthRequests: fragment.healthRequests,
      hashAfterBootstrap: fragmentState.hash,
      selected: fragmentState.activeId === fragmentState.servers[0].id,
      tokenStored: fragmentState.servers[0].token === 'fragment-smoke-token'
    }
  }, null, 2));
} finally {
  await browser.close();
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}
