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

const sessions = [
  {
    id: 'codex-1', cmd: 'codex', args: [], cwd: '/tmp/codex', cols: 120, rows: 40,
    createdAt: 1, pid: 101, tool: 'codex', working: false, lastDataAt: 1,
    lastUserMessageAt: null, exited: false, exitCode: null, exitSignal: null, exitedAt: null
  },
  {
    id: 'claude-1', cmd: 'claude', args: [], cwd: '/tmp/claude', cols: 120, rows: 40,
    createdAt: 2, pid: 102, tool: 'claude-code', working: false, lastDataAt: 2,
    lastUserMessageAt: null, exited: false, exitCode: null, exitSignal: null, exitedAt: null
  },
  {
    id: 'shell-1', cmd: 'zsh', args: [], cwd: '/tmp/shell', cols: 120, rows: 40,
    createdAt: 3, pid: 103, tool: 'terminal', working: false, lastDataAt: 3,
    lastUserMessageAt: null, exited: false, exitCode: null, exitSignal: null, exitedAt: null
  },
  {
    id: 'finished-parent', cmd: 'claude', args: [], cwd: '/tmp/parent', cols: 120, rows: 40,
    createdAt: 4, pid: 104, tool: 'claude-code', working: false, lastDataAt: 4,
    lastUserMessageAt: 4, exited: true, exitCode: 0, exitSignal: null, exitedAt: 4
  },
  {
    id: 'finished-child', parentSessionId: 'finished-parent', cmd: 'codex', args: [], cwd: '/tmp/child', cols: 120, rows: 40,
    createdAt: 5, pid: 105, tool: 'codex', working: false, lastDataAt: 5,
    lastUserMessageAt: 5, exited: true, exitCode: 0, exitSignal: null, exitedAt: 5
  },
  {
    id: 'live-grandchild', parentSessionId: 'finished-child', cmd: 'zsh', args: [], cwd: '/tmp/grandchild', cols: 120, rows: 40,
    createdAt: 6, pid: 106, tool: 'terminal', working: true, lastDataAt: 6,
    lastUserMessageAt: null, exited: false, exitCode: null, exitSignal: null, exitedAt: null
  }
];

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
}

function addressOf(server) {
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('server did not bind');
  return address;
}

function daemonServer(sessionPrefix) {
  let sessionRequests = 0;
  const server = http.createServer((request, response) => {
    response.setHeader('access-control-allow-origin', '*');
    const requested = new URL(request.url ?? '/', 'http://sessions.test');
    if (requested.pathname === '/api/sessions') {
      if (requested.searchParams.get('include_exited') !== '1') {
        response.writeHead(400, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: 'operations inbox must request exited sessions' }));
        return;
      }
      sessionRequests += 1;
      response.writeHead(200, { 'content-type': 'application/json' });
      const body = sessionPrefix
        ? sessions.map((session) => ({
            ...session,
            id: `${sessionPrefix}-${session.id}`,
            parentSessionId: session.parentSessionId ? `${sessionPrefix}-${session.parentSessionId}` : undefined
          }))
        : sessions;
      response.end(JSON.stringify({ sessions: body }));
      return;
    }
    if (requested.pathname.endsWith('/api/history/finished-parent/preview')) {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({
        schemaVersion: 1,
        session: { id: 'finished-parent', name: 'Finished parent', tool: 'claude', cwd: '/tmp/parent', machine: 'Primary', created_at: 4, last_activity_at: 4, message_count: 1, conversation_available: true },
        messages: [{ role: 'assistant', text: 'Finished safely.', timestamp: '2026-07-22T00:00:00Z' }]
      }));
      return;
    }
    response.writeHead(404, { 'content-type': 'application/json' });
    response.end('{}');
  });
  return {
    server,
    get sessionRequests() { return sessionRequests; }
  };
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

const uiServer = http.createServer((request, response) => {
  const pathname = decodeURIComponent(new URL(request.url ?? '/', 'http://localhost').pathname);
  const relativePath = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const filePath = path.resolve(distDir, relativePath);
  if (!filePath.startsWith(`${distDir}${path.sep}`) || !fs.existsSync(filePath)) {
    response.writeHead(404).end('not found');
    return;
  }
  response.writeHead(200, {
    'content-type': contentTypes.get(path.extname(filePath)) ?? 'application/octet-stream'
  });
  fs.createReadStream(filePath).pipe(response);
});

const primary = daemonServer('');
const scoped = daemonServer('scoped');
await Promise.all([listen(uiServer), listen(primary.server), listen(scoped.server)]);

const uiAddress = addressOf(uiServer);
const primaryAddress = addressOf(primary.server);
const scopedAddress = addressOf(scoped.server);
const origin = `http://127.0.0.1:${uiAddress.port}`;
const storedServers = [
  {
    id: 'primary-server', name: 'Primary', host: '127.0.0.1', port: primaryAddress.port,
    isDefault: false, scheme: 'http'
  },
  {
    id: 'scoped-server', name: 'Scoped', host: '127.0.0.1', port: scopedAddress.port,
    isDefault: false, scheme: 'http'
  }
];

const browser = await puppeteer.launch({
  headless: true,
  args: ['--no-sandbox', '--disable-dev-shm-usage']
});

async function openCase(query, selector = '[role="tab"][data-tab-id]') {
  const page = await browser.newPage();
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.evaluateOnNewDocument((serversValue) => {
    window.localStorage.clear();
    window.localStorage.setItem('sessions:servers', JSON.stringify(serversValue));
    window.localStorage.setItem('sessions:active-server', 'primary-server');
  }, storedServers);
  await page.goto(`${origin}/${query}`, { waitUntil: 'domcontentloaded', timeout: 15_000 });
  await page.waitForSelector(selector, { timeout: 10_000 });
  return { page, pageErrors };
}

async function tabIds(query) {
  const current = await openCase(query);
  await current.page.waitForFunction(
    () => document.querySelectorAll('[role="tab"][data-tab-id]').length > 0
  );
  const ids = await current.page.evaluate(() =>
    [...document.querySelectorAll('[role="tab"][data-tab-id]')]
      .map((node) => node.getAttribute('data-tab-id'))
  );
  assert.deepEqual(current.pageErrors, []);
  await current.page.close();
  return ids;
}

async function navigatorIds(query) {
  const current = await openCase(query, '.session-nav-row[data-session-id]');
  const ids = await current.page.evaluate(() =>
    [...document.querySelectorAll('.session-nav-row[data-session-id]')]
      .map((node) => node.getAttribute('data-session-id'))
  );
  assert.deepEqual(current.pageErrors, []);
  await current.page.close();
  return ids;
}

async function assertFinishedSessionIsReadOnly() {
  const current = await openCase('', '.session-nav-row[data-session-id="finished-parent"]');
  await current.page.evaluate(() => {
    const row = document.querySelector('.session-nav-row[data-session-id="finished-parent"]');
    if (!(row instanceof HTMLElement)) throw new Error('finished parent row is missing');
    row.click();
  });
  await current.page.waitForSelector('.session-view-host:not(.is-hidden) .session-history-body');
  const state = await current.page.evaluate(() => {
    const node = document.querySelector('.session-view-host:not(.is-hidden)');
    if (!node) throw new Error('active finished session is missing');
    return {
      history: Boolean(node.querySelector('.session-history-body')),
      terminal: Boolean(node.querySelector('.terminal-host')),
      copy: node.textContent
    };
  });
  assert.equal(state.history, true);
  assert.equal(state.terminal, false);
  assert.match(state.copy ?? '', /viewing does not resume or send anything/i);
  assert.deepEqual(current.pageErrors, []);
  await current.page.close();
}

try {
  // The operations-inbox contract keeps every scoped session in the
  // navigator but only the explicitly opened/active one in the tab strip.
  assert.deepEqual(await navigatorIds(''), ['finished-parent', 'finished-child', 'live-grandchild', 'shell-1', 'claude-1', 'codex-1']);
  await assertFinishedSessionIsReadOnly();
  assert.deepEqual(await tabIds(''), ['codex-1']);
  assert.deepEqual(await tabIds('?tool=codex'), ['codex-1']);
  assert.deepEqual(await tabIds('?tool=claude'), ['claude-1']);
  assert.deepEqual(await tabIds('?tool=shell'), ['shell-1']);

  const primaryBefore = primary.sessionRequests;
  const scopedBefore = scoped.sessionRequests;
  assert.deepEqual(
    await tabIds('?server=scoped-server'),
    ['scoped-codex-1']
  );
  assert.equal(primary.sessionRequests, primaryBefore);
  assert.ok(scoped.sessionRequests > scopedBefore);

  const single = await openCase('?session=codex-1&mode=single', '.single-mode');
  await single.page.waitForFunction(
    () => document.querySelector('.single-mode-label')?.textContent?.trim() === 'codex'
  );
  const singleLabel = await single.page.evaluate(
    () => document.querySelector('.single-mode-label')?.textContent?.trim()
  );
  assert.equal(singleLabel, 'codex');
  assert.deepEqual(single.pageErrors, []);
  await single.page.close();

  console.log(JSON.stringify({
    navigator: 6,
    readOnlyHistory: true,
    openTabs: 1,
    toolScopes: ['codex', 'claude', 'shell'],
    serverScope: 'scoped-server',
    singleSession: 'codex-1',
    result: 'ok'
  }));
} finally {
  await browser.close();
  await Promise.all([
    new Promise((resolve) => uiServer.close(resolve)),
    new Promise((resolve) => primary.server.close(resolve)),
    new Promise((resolve) => scoped.server.close(resolve))
  ]);
}
