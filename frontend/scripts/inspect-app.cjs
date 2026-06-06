#!/usr/bin/env node
// Headless-browser inspection of the running pretty-PTY frontend.
//
// Why this exists: macOS Screen Recording / Accessibility permissions
// are awkward to grant when the host process is an agent rather than a
// user-launched app. Puppeteer ships its own Chromium binary that runs
// in a sandbox and needs no system permissions, so an agent can drive
// the page, capture errors, and screenshot WITHOUT touching the user's
// real browser session.
//
// Usage:
//   node scripts/inspect-app.cjs                       # default: http://127.0.0.1:5273/
//   node scripts/inspect-app.cjs --url http://...      # different URL
//   node scripts/inspect-app.cjs --click-tab Pretty    # click a button by visible text
//   node scripts/inspect-app.cjs --click-tab Terminal  #   ... before screenshot
//   node scripts/inspect-app.cjs --wait 1500           # extra ms to wait after load
//
// Outputs to /tmp/pretty-pty-inspect/:
//   - screenshot.png         full-page render
//   - console.log            every console message + page errors
//   - requests.log           failed network requests
//   - dom-summary.txt        first ~80 lines of textContent + computed styles
//                            for key selectors (.app-shell, .tab, .conn-status)
//
// Designed to be cheap to run repeatedly. ~2s end-to-end on dev server.

const path = require('node:path');
const fs = require('node:fs');

const FRONTEND_ROOT = path.resolve(__dirname, '..');
const puppeteer = require(path.join(FRONTEND_ROOT, 'node_modules', 'puppeteer'));

const args = process.argv.slice(2);
function arg(name, fallback) {
  const i = args.indexOf('--' + name);
  return i >= 0 ? args[i + 1] : fallback;
}

const URL = arg('url', 'http://127.0.0.1:5273/');
const CLICK_TAB = arg('click-tab', null); // 'Pretty' / 'Terminal' / 'Split'
const EXTRA_WAIT = Number(arg('wait', 1500));

const OUT_DIR = '/tmp/pretty-pty-inspect';
fs.mkdirSync(OUT_DIR, { recursive: true });

(async () => {
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-dev-shm-usage']
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800, deviceScaleFactor: 2 });

  const consoleMsgs = [];
  page.on('console', (msg) => {
    consoleMsgs.push(`[${msg.type()}] ${msg.text()}`);
  });
  page.on('pageerror', (err) => {
    consoleMsgs.push(`[pageerror] ${err.message}\n${err.stack || ''}`);
  });
  const failedRequests = [];
  page.on('requestfailed', (req) => {
    failedRequests.push(`${req.method()} ${req.url()} → ${req.failure()?.errorText}`);
  });
  page.on('response', (res) => {
    if (!res.ok() && res.status() !== 304) {
      failedRequests.push(`${res.request().method()} ${res.url()} → ${res.status()}`);
    }
  });

  console.log(`navigating to ${URL}…`);
  try {
    await page.goto(URL, { waitUntil: 'networkidle2', timeout: 10_000 });
  } catch (err) {
    console.error('goto failed:', err.message);
  }
  await new Promise((r) => setTimeout(r, EXTRA_WAIT));

  if (CLICK_TAB) {
    try {
      // Click a view-mode toggle by its visible text.
      await page.evaluate((label) => {
        const btn = [...document.querySelectorAll('.view-toggle-btn')]
          .find((b) => b.textContent?.trim() === label);
        if (btn) btn.click();
      }, CLICK_TAB);
      await new Promise((r) => setTimeout(r, 600));
    } catch (err) {
      console.error('click failed:', err.message);
    }
  }

  // Snapshot key DOM/style facts so we can answer "is anything actually
  // styled" without eyeballing the screenshot.
  const domSummary = await page.evaluate(() => {
    function brief(el) {
      if (!el) return null;
      const cs = getComputedStyle(el);
      return {
        exists: true,
        tag: el.tagName.toLowerCase(),
        classes: el.className,
        bg: cs.backgroundColor,
        color: cs.color,
        font: cs.fontFamily.slice(0, 40),
        display: cs.display,
        width: cs.width,
        height: cs.height
      };
    }
    const root = document.getElementById('root');
    const sheets = [...document.styleSheets].map((s) => ({
      href: s.href || '(inline)',
      rules: (() => { try { return s.cssRules.length; } catch { return 'CORS'; } })()
    }));
    return {
      title: document.title,
      bodyText: document.body.innerText.slice(0, 600),
      rootChildren: root ? root.children.length : null,
      bodyBg: getComputedStyle(document.body).backgroundColor,
      bodyColor: getComputedStyle(document.body).color,
      bodyFont: getComputedStyle(document.body).fontFamily.slice(0, 60),
      sheets,
      appShell: brief(document.querySelector('.app-shell')),
      appHeader: brief(document.querySelector('.app-header')),
      tab:       brief(document.querySelector('.tab')),
      connDot:   brief(document.querySelector('.conn-dot')),
      sessionView: brief(document.querySelector('.session-view')),
      terminalHost: brief(document.querySelector('.terminal-host')),
      prettyView: brief(document.querySelector('.pretty-view'))
    };
  });

  fs.writeFileSync(path.join(OUT_DIR, 'console.log'), consoleMsgs.join('\n'));
  fs.writeFileSync(path.join(OUT_DIR, 'requests.log'), failedRequests.join('\n'));
  fs.writeFileSync(path.join(OUT_DIR, 'dom-summary.json'), JSON.stringify(domSummary, null, 2));
  await page.screenshot({ path: path.join(OUT_DIR, 'screenshot.png'), fullPage: true });

  await browser.close();

  console.log('\n=== console messages ===');
  console.log(consoleMsgs.length ? consoleMsgs.join('\n') : '(none)');
  console.log('\n=== failed requests ===');
  console.log(failedRequests.length ? failedRequests.join('\n') : '(none)');
  console.log('\n=== DOM summary ===');
  console.log(JSON.stringify(domSummary, null, 2));
  console.log(`\nfiles: ${OUT_DIR}/{screenshot.png, console.log, requests.log, dom-summary.json}`);
})().catch((err) => {
  console.error('inspect-app failed:', err);
  process.exit(1);
});
