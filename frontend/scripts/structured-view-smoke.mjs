import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import puppeteer from 'puppeteer';

const work = await mkdtemp(join(tmpdir(), 'sessions-structured-view-'));
const publicDir = fileURLToPath(new URL('../public/', import.meta.url));
const screenshot = process.env.STRUCTURED_VIEW_SCREENSHOT || join(work, 'structured-view.png');
let browser;
let server;

try {
  await build({
    entryPoints: [new URL('./structured-view-fixture.tsx', import.meta.url).pathname],
    outdir: work,
    bundle: true,
    platform: 'browser',
    format: 'esm',
    define: { 'import.meta.env.BASE_URL': '"/"' },
    entryNames: 'app',
    assetNames: 'asset-[hash]',
    external: ['/claude.png'],
    loader: { '.svg': 'dataurl', '.png': 'dataurl' },
    logLevel: 'silent'
  });
  await writeFile(join(work, 'index.html'), `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<link rel="stylesheet" href="/app.css"></head><body><div id="root"></div>
<script>localStorage.setItem('pretty-pty:servers', JSON.stringify([{id:'fixture',name:'Fixture',host:'127.0.0.1',port:8787,isDefault:true}]));localStorage.setItem('pretty-pty:active-server','fixture');</script>
<script type="module" src="/app.js"></script></body></html>`);

  server = createServer(async (request, response) => {
    const name = request.url === '/' ? 'index.html' : request.url.slice(1);
    try {
      const source = name === 'openai-icon.svg' || name === 'claude.png'
        ? join(publicDir, name)
        : join(work, name);
      const body = await readFile(source);
      const type = extname(name) === '.css'
        ? 'text/css'
        : extname(name) === '.js'
          ? 'text/javascript'
          : extname(name) === '.svg'
            ? 'image/svg+xml'
            : extname(name) === '.png'
              ? 'image/png'
              : 'text/html';
      response.writeHead(200, { 'content-type': type });
      response.end(body);
    } catch {
      response.writeHead(404);
      response.end();
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('fixture server did not bind');

  browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox'] });
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 960, deviceScaleFactor: 1 });
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.goto(`http://127.0.0.1:${address.port}`, { waitUntil: 'networkidle0' });
  await page.waitForSelector('.remote-bubble-plan');
  await page.click('.remote-bubble-tools-toggle');
  await page.click('.remote-bubble-tool');

  const report = await page.evaluate(() => ({
    planSteps: document.querySelectorAll('.remote-bubble-plan-step').length,
    activityItems: document.querySelectorAll('.remote-bubble-tool-row').length,
    reasoning: document.querySelector('.remote-bubble-reasoning')?.textContent ?? '',
    updates: document.querySelector('.remote-bubble-updates')?.textContent ?? '',
    stopControl: [...document.querySelectorAll('.qk-label')].map((node) => node.textContent).join(' '),
    parserIconWidth: document.querySelector('.parser-icon-img')?.naturalWidth ?? 0,
    horizontalOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth
  }));
  assert.equal(report.planSteps, 3);
  assert.equal(report.activityItems, 2);
  assert.match(report.reasoning, /Reasoning summary/);
  assert.match(report.updates, /progress update/);
  assert.match(report.stopControl, /Stop turn/);
  assert.ok(report.parserIconWidth > 0);
  assert.equal(report.horizontalOverflow, 0);
  assert.deepEqual(pageErrors, []);
  await page.screenshot({ path: screenshot, fullPage: true });
  process.stdout.write(`structured-view smoke passed: ${screenshot}\n`);
} finally {
  if (browser) await browser.close();
  if (server) await new Promise((resolve) => server.close(resolve));
  if (!process.env.STRUCTURED_VIEW_SCREENSHOT) await rm(work, { recursive: true, force: true });
}
