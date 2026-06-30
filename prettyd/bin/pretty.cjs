#!/usr/bin/env node
// `pretty` — CLI for prettyd. Designed for openclaw agents (and humans)
// to inspect and drive sessions without opening a WebSocket.
//
// Subcommands:
//   pretty ls                       List sessions (id, tool, cwd, working, age).
//   pretty snap <id>                Print current xterm buffer (clean text).
//   pretty snap <id> --raw          Print buffer with ANSI escapes preserved.
//   pretty send <id> <text...>      Send text + Enter to the session.
//   pretty keys <id> <key>          Send a control key: esc | up | down | ^c.
//   pretty new [--cwd P] [--cmd C] [args...]
//                                   Create a new session.
//   pretty kill <id>                Terminate the session's runner.
//   pretty attach <id>              Stream the session to your terminal
//                                   (raw bytes, two-way; Ctrl+Q to detach).
//   pretty help                     This.
//
// Global flags:
//   --json     Output JSON (machine-friendly) where applicable.
//   --host     prettyd host (default: 127.0.0.1).
//   --port     prettyd port (default: 8787).
//
// Exit codes:
//   0 success · 1 user error (bad args, unknown id) · 2 transport error.

'use strict';

const http = require('node:http');
const https = require('node:https');
const path = require('node:path');
const url = require('node:url');
const { randomUUID } = require('node:crypto');

const argv = process.argv.slice(2);

function readGlobalFlag(name, fallback) {
  const i = argv.indexOf('--' + name);
  if (i < 0) return fallback;
  const v = argv[i + 1];
  argv.splice(i, 2);
  return v;
}
const HOST = readGlobalFlag('host', process.env.PRETTYD_HOST || '127.0.0.1');
const PORT = readGlobalFlag('port', process.env.PRETTYD_PORT || '8787');
const wantJson = argv.includes('--json');
if (wantJson) argv.splice(argv.indexOf('--json'), 1);

const sub = argv.shift();

function fail(msg, code = 1) {
  process.stderr.write(`pretty: ${msg}\n`);
  process.exit(code);
}

function api(method, p, body) {
  return new Promise((resolve, reject) => {
    const data = body !== undefined ? Buffer.from(JSON.stringify(body)) : null;
    const req = http.request({
      method,
      host: HOST,
      port: Number(PORT),
      path: p,
      headers: data ? { 'content-type': 'application/json', 'content-length': data.length } : {}
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        resolve({ status: res.statusCode, headers: res.headers, body: buf });
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

async function getJson(p) {
  const r = await api('GET', p);
  if (r.status >= 400) fail(`${p} → ${r.status} ${r.body.toString('utf8').slice(0, 200)}`, 2);
  return JSON.parse(r.body.toString('utf8'));
}
async function postJson(p, body) {
  const r = await api('POST', p, body);
  if (r.status >= 400) fail(`${p} → ${r.status} ${r.body.toString('utf8').slice(0, 200)}`, 2);
  return JSON.parse(r.body.toString('utf8'));
}
async function del(p) {
  const r = await api('DELETE', p);
  if (r.status >= 400 && r.status !== 404) fail(`${p} → ${r.status}`, 2);
  return r.status === 200;
}
async function getText(p) {
  const r = await api('GET', p);
  if (r.status === 404) return null;
  if (r.status >= 400) fail(`${p} → ${r.status}`, 2);
  return r.body.toString('utf8');
}

function ageOf(createdAt) {
  const s = Math.max(0, Math.round((Date.now() - createdAt) / 1000));
  if (s < 60) return s + 's';
  const m = Math.round(s / 60);
  if (m < 60) return m + 'm';
  const h = Math.round(m / 60);
  if (h < 48) return h + 'h';
  return Math.round(h / 24) + 'd';
}

function classifyTool(cmd, args) {
  const c = (cmd || '').toLowerCase();
  if (c.endsWith('/claude') || c === 'claude') return 'claude';
  if (c.endsWith('/codex') || c === 'codex') return 'codex';
  return path.basename(c) || 'shell';
}

// Small ANSI stripper — same regex used everywhere in pretty-PTY.
const ANSI_RE = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07]*\x07/g;
const CURSOR_FORWARD_RE = /\x1b\[(\d+)C/g;
function normalize(s) {
  return s.replace(CURSOR_FORWARD_RE, (_, n) => ' '.repeat(parseInt(n, 10)));
}

// ────────────────────────────────────────────────────────────────────────
// Subcommands.

// `pretty doctor` — per-session health: is the runner on the un-throttled
// (Interactive QoS) plist, and on the fast compiled spawn path? Surfaces the
// exact "this session is old / background-classed / running via tsx" state
// that otherwise needs shell archaeology to find. A session flagged here is
// fixed by recreating it (or a full app restart respawns every runner clean).
async function cmdDoctor() {
  const fs = require('node:fs');
  const os = require('node:os');
  const { execFileSync } = require('node:child_process');
  const agents = path.join(os.homedir(), 'Library', 'LaunchAgents');
  const ps1 = (fmt, pid) => {
    try { return execFileSync('ps', ['-o', fmt, '-p', String(pid)], { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); }
    catch { return ''; }
  };
  const { sessions } = await getJson('/api/sessions');
  let deep = null;
  try { deep = await getJson('/api/health/deep'); } catch { /* older daemon */ }

  const rows = sessions.map((s) => {
    let qos = 'no-plist';
    try {
      const xml = fs.readFileSync(path.join(agents, `tech.pretty-pty.runner.${s.id}.plist`), 'utf8');
      const m = xml.match(/<key>ProcessType<\/key>\s*<string>([^<]+)<\/string>/);
      qos = m ? m[1] : 'none';
    } catch { qos = 'no-plist'; }
    let spawn = 'dead?';
    if (s.pid) {
      const ppid = ps1('ppid=', s.pid);
      const pcmd = ppid ? ps1('command=', ppid) : '';
      spawn = /dist\/runner\.js/.test(pcmd) ? 'dist' : (/tsx\b/.test(pcmd) ? 'tsx-SLOW' : (pcmd ? 'other' : 'dead?'));
    }
    const ok = qos === 'Interactive' && spawn === 'dist';
    return { id: s.id, tool: s.tool || classifyTool(s.cmd, s.args), size: `${s.cols}x${s.rows}`, qos, spawn, ok };
  });

  if (wantJson) {
    process.stdout.write(JSON.stringify({ daemon: deep, sessions: rows }, null, 2) + '\n');
    return;
  }
  if (deep) {
    process.stdout.write(`daemon: ${deep.sessionsLoaded} sessions, discovering=${deep.discovering}, uptime=${deep.uptimeSec}s\n\n`);
  }
  const W = (s, n) => String(s).slice(0, n - 1).padEnd(n);
  const shortTool = (t) => (t === 'claude-code' ? 'claude' : t);
  process.stdout.write(`${W('ID', 10)}${W('TOOL', 8)}${W('SIZE', 10)}${W('QoS', 13)}${W('SPAWN', 10)}STATUS\n`);
  for (const r of rows) {
    process.stdout.write(`${W(r.id.slice(0, 8), 10)}${W(shortTool(r.tool), 8)}${W(r.size, 10)}${W(r.qos, 13)}${W(r.spawn, 10)}${r.ok ? 'ok' : '⚠ needs recreate'}\n`);
  }
  const bad = rows.filter((r) => !r.ok);
  process.stdout.write(`\n${bad.length} of ${rows.length} sessions need recreate `);
  process.stdout.write(bad.length ? '(throttled QoS and/or slow tsx spawn — recreate them or do a full app restart for the fast path).\n' : '— all healthy (Interactive QoS, fast dist spawn).\n');
  if (bad.length) process.exitCode = 1;
}

async function cmdLs(args) {
  const includeExited = args.includes('--include-exited') || args.includes('-a') || wantJson;
  const path = includeExited ? '/api/sessions?include_exited=1' : '/api/sessions';
  const { sessions } = await getJson(path);
  if (wantJson) {
    process.stdout.write(JSON.stringify(sessions, null, 2) + '\n');
    return;
  }
  if (sessions.length === 0) {
    process.stdout.write('(no sessions)\n');
    return;
  }
  const stateOf = (s) => {
    if (s.exited) {
      const code = s.exitCode === null ? '∅' : s.exitCode;
      const sig = s.exitSignal ? ` ${s.exitSignal}` : '';
      return `exited(${code}${sig})`;
    }
    return s.working ? 'working' : 'idle';
  };
  const cols = [
    ['ID', (s) => s.id.slice(0, 8)],
    ['TOOL', (s) => s.tool || classifyTool(s.cmd, s.args)],
    ['CWD', (s) => s.cwd.replace(process.env.HOME || '', '~')],
    ['STATE', stateOf],
    ['AGE', (s) => ageOf(s.createdAt)],
    // When the human last typed a real message (from the Claude JSONL).
    // '-' for non-Claude sessions or before the first message. The
    // staleness signal: a session idle for days here is a cull candidate.
    ['LAST-USER', (s) => (s.lastUserMessageAt ? ageOf(s.lastUserMessageAt) : '-')],
    ['PID', (s) => String(s.pid)]
  ];
  const rows = [cols.map(([h]) => h), ...sessions.map((s) => cols.map(([, fn]) => fn(s)))];
  const widths = cols.map((_, c) => Math.max(...rows.map((r) => r[c].length)));
  for (const r of rows) {
    process.stdout.write(r.map((cell, i) => cell.padEnd(widths[i])).join('  ') + '\n');
  }
}

async function cmdSnap(id, raw) {
  if (!id) fail('usage: pretty snap <id> [--raw]');
  const text = await getText(`/api/sessions/${encodeURIComponent(id)}/snapshot`);
  if (text === null) fail(`unknown session: ${id}`, 1);
  const out = raw ? text : normalize(text).replace(ANSI_RE, '');
  process.stdout.write(out);
  if (!out.endsWith('\n')) process.stdout.write('\n');
}

async function cmdSend(id, text) {
  if (!id || text === undefined) fail('usage: pretty send <id> <text...>');
  // Send the message body and the Enter as TWO separate PTY writes, with a
  // beat in between. Claude Code treats a single bulk write of "text\r" as
  // a paste, so the trailing \r lands as a newline *inside* the multiline
  // input box and the message never submits (it just stacks up). Writing
  // the text, pausing, then sending a lone \r makes Claude see the Enter as
  // a discrete keystroke → submit. Harmless for non-Claude PTYs (a shell
  // submits on \r either way).
  const url = `/api/sessions/${encodeURIComponent(id)}/input`;
  await postJson(url, { data: text });
  await new Promise((r) => setTimeout(r, 150));
  await postJson(url, { data: '\r' });
}

const KEY_BYTES = {
  esc: '\x1b',
  escape: '\x1b',
  up: '\x1b[A',
  down: '\x1b[B',
  left: '\x1b[D',
  right: '\x1b[C',
  '^c': '\x03',
  ctrlc: '\x03',
  '^d': '\x04',
  ctrld: '\x04',
  enter: '\r',
  tab: '\t'
};
async function cmdKeys(id, key) {
  if (!id || !key) fail('usage: pretty keys <id> <esc|up|down|left|right|^c|^d|enter|tab>');
  const bytes = KEY_BYTES[key.toLowerCase()];
  if (!bytes) fail(`unknown key '${key}'. valid: ${Object.keys(KEY_BYTES).join(', ')}`);
  await postJson(`/api/sessions/${encodeURIComponent(id)}/input`, { data: bytes });
}

// Tool shortcuts. `pretty new --tool claude` resolves to the same
// command + args you'd otherwise type by hand. We default to
// skip-permissions ON because that matches the New Session dialog's
// default and the day-to-day workflow — flag with --no-skip-perms to
// opt out for one-off careful runs.
const TOOL_PRESETS = {
  claude: {
    cmd: '/opt/homebrew/bin/claude',
    args: ['--dangerously-skip-permissions']
  },
  codex: {
    cmd: '/opt/homebrew/bin/codex',
    // codex >=0.137 removed `--full-auto` (parse error -> instant exit).
    // This is the no-prompts equivalent: sandboxed to the workspace,
    // never blocks on an approval prompt (matches the skip-perms
    // workflow; a stalled prompt is unusable from a phone/agent loop).
    args: ['--sandbox', 'workspace-write', '--ask-for-approval', 'never']
  },
  shell: {
    cmd: undefined, // prettyd default = $SHELL
    args: undefined
  }
};

async function cmdNew(args) {
  const body = {};
  // Strip flags one at a time; recompute indices after each splice so
  // later flags aren't off-by-N. Whatever's left is `cmd [args...]`
  // when --cmd wasn't given, or just additional args to the --cmd value
  // when it was.
  function pluck(name) {
    const i = args.indexOf(name);
    if (i < 0) return undefined;
    const v = args[i + 1];
    args.splice(i, 2);
    return v;
  }
  function hasFlag(name) {
    const i = args.indexOf(name);
    if (i < 0) return false;
    args.splice(i, 1);
    return true;
  }
  const cwdVal = pluck('--cwd');
  if (cwdVal !== undefined) body.cwd = cwdVal;

  const toolVal = pluck('--tool');
  const noSkipPerms = hasFlag('--no-skip-perms');
  if (toolVal !== undefined) {
    const preset = TOOL_PRESETS[toolVal.toLowerCase()];
    if (!preset) {
      fail(`unknown --tool '${toolVal}'. valid: ${Object.keys(TOOL_PRESETS).join(', ')}`, 1);
    }
    if (preset.cmd) body.cmd = preset.cmd;
    // Strip the skip-permissions flag if --no-skip-perms was passed.
    if (preset.args) {
      body.args = noSkipPerms
        ? preset.args.filter((a) => !/^--(dangerously-skip-permissions|full-auto)$/.test(a))
        : preset.args.slice();
    }
    // Any leftover positional args become extra args to the tool.
    if (args.length > 0) {
      body.args = (body.args || []).concat(args);
    }
    // Pin a Claude session id so prettyd's JSONL watcher can locate the
    // conversation file (it's the ONLY locator — no mtime fallback). The
    // New Session dialog already does this; without it `pretty new --tool
    // claude` sessions get an empty Pretty view, no titles, and may boot
    // into Claude's resume picker. Skip if the caller already pinned one.
    if (toolVal.toLowerCase() === 'claude') {
      const a = body.args || (body.args = []);
      if (!a.some((x) => x === '--session-id' || x === '--resume')) {
        a.push('--session-id', randomUUID());
      }
    }
  } else {
    const cmdVal = pluck('--cmd');
    if (cmdVal !== undefined) {
      body.cmd = cmdVal;
      if (args.length > 0) body.args = args.slice();
    } else if (args.length > 0) {
      body.cmd = args[0];
      body.args = args.slice(1);
    }
  }
  const info = await postJson('/api/sessions', body);
  if (wantJson) {
    process.stdout.write(JSON.stringify(info, null, 2) + '\n');
  } else {
    process.stdout.write(info.id + '\n');
  }
}

async function cmdKill(ids) {
  if (!ids || ids.length === 0) fail('usage: pretty kill <id> [<id>...]');
  // Accept several ids so stale sessions can be culled in one command
  // (`pretty kill a1b2 c3d4 …`). Each kill is reported individually;
  // exit 1 if any id was unknown.
  let anyFailed = false;
  for (const id of ids) {
    const ok = await del(`/api/sessions/${encodeURIComponent(id)}`);
    if (ok) {
      process.stdout.write(`killed ${id}\n`);
    } else {
      process.stderr.write(`unknown session: ${id}\n`);
      anyFailed = true;
    }
  }
  if (anyFailed) process.exit(1);
}

// Parse 2s, 500ms, 1m, etc. into milliseconds. Bare numbers are seconds.
function parseDuration(s, fallbackMs) {
  if (!s) return fallbackMs;
  const m = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h)?$/i.exec(s);
  if (!m) fail(`bad duration '${s}' — try 2s, 500ms, 1m, 30s`, 1);
  const n = parseFloat(m[1]);
  const unit = (m[2] || 's').toLowerCase();
  return unit === 'ms' ? n
    : unit === 's' ? n * 1000
    : unit === 'm' ? n * 60_000
    : n * 3_600_000;
}

async function cmdTail(args) {
  const id = args.shift();
  if (!id) fail('usage: pretty tail <id> [-f] [-n N]');
  const follow = args.includes('-f') || args.includes('--follow');
  let n = 50;
  for (let i = 0; i < args.length; i++) {
    if ((args[i] === '-n' || args[i] === '--lines') && args[i + 1]) {
      n = parseInt(args[i + 1], 10);
      if (!Number.isFinite(n) || n < 1) fail('--lines must be a positive integer', 1);
    }
  }
  // Print the current buffer's last N lines (clean, normalized).
  const text = await getText(`/api/sessions/${encodeURIComponent(id)}/snapshot`);
  if (text === null) fail(`unknown session: ${id}`, 1);
  const cleaned = normalize(text).replace(ANSI_RE, '');
  const lines = cleaned.split('\n');
  // Trim trailing blank rows xterm pads to fill the buffer to its row count.
  while (lines.length > 0 && lines[lines.length - 1].trim() === '') lines.pop();
  const tailLines = lines.slice(-n);
  process.stdout.write(tailLines.join('\n'));
  if (tailLines.length > 0) process.stdout.write('\n');

  if (!follow) return;

  // Live follow — open a WS and print every OUTPUT frame's data straight
  // through. ANSI escapes pass through too so colors render in the user's
  // terminal. Ctrl+C exits. The seq we anchor at is whatever is current
  // when the snapshot was taken, so there's a tiny chance of a 1-event
  // overlap — agents using this for coordination should prefer `wait`.
  const ws = (() => {
    try { return require(path.resolve(__dirname, '..', 'node_modules', 'ws')); }
    catch { fail('tail -f needs `ws` installed in prettyd/node_modules', 2); }
  })();
  const sock = new ws(`ws://${HOST}:${PORT}/ws?sessionId=${encodeURIComponent(id)}`);
  sock.on('message', (raw) => {
    let m;
    try { m = JSON.parse(raw.toString()); } catch { return; }
    if (m.type === 'output') process.stdout.write(m.data);
    if (m.type === 'exit') {
      process.stdout.write(`\n[session exited code=${m.code ?? '∅'}]\n`);
      process.exit(0);
    }
  });
  sock.on('close', () => process.exit(0));
  // Keep the process alive on the WS event loop. Don't return.
  await new Promise(() => {});
}

async function cmdWait(args) {
  const id = args.shift();
  if (!id) fail('usage: pretty wait <id> [--idle 2s] [--timeout 30s]');
  let idleMs = 2000;
  let timeoutMs = 30_000;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--idle' && args[i + 1]) idleMs = parseDuration(args[i + 1]);
    if (args[i] === '--timeout' && args[i + 1]) timeoutMs = parseDuration(args[i + 1]);
  }
  // "Done with its turn" detection. For Claude Code sessions we key off
  // the `working` flag, which the daemon derives from Claude's own
  // "esc to interrupt" / live spinner footer — NOT byte rate. This is the
  // honest signal: a custom statusline (e.g. `/goal active (3d)◎`)
  // repaints forever and keeps `lastDataAt` fresh, so the old
  // lastDataAt-based wait would never return for an idle Claude session.
  // We return once `working` has stayed false for idleMs continuously.
  //
  // Non-Claude sessions (bash, codex, …) have no such footer, so we fall
  // back to the byte-rate lastDataAt heuristic.
  const start = Date.now();
  const pollInterval = Math.max(100, Math.min(idleMs / 4, 500));
  let notWorkingSince = null; // claude path: when `working` last went false
  while (true) {
    const { sessions } = await getJson('/api/sessions');
    const s = sessions.find((x) => x.id === id);
    if (!s) {
      // Treat "session gone" as an exit — the user's caller usually wants
      // to know the session is no longer running, not error out.
      if (wantJson) process.stdout.write(JSON.stringify({ ok: true, reason: 'gone' }) + '\n');
      else process.stdout.write('gone\n');
      return;
    }
    let idleFor;
    if (s.tool === 'claude-code') {
      if (s.working) notWorkingSince = null;
      else if (notWorkingSince === null) notWorkingSince = Date.now();
      idleFor = notWorkingSince === null ? 0 : Date.now() - notWorkingSince;
    } else {
      idleFor = Date.now() - (s.lastDataAt || s.createdAt);
    }
    if (idleFor >= idleMs) {
      const result = { ok: true, reason: 'idle', idleMs: idleFor, working: s.working };
      if (wantJson) process.stdout.write(JSON.stringify(result) + '\n');
      else process.stdout.write(`idle for ${idleFor}ms\n`);
      return;
    }
    if (Date.now() - start >= timeoutMs) {
      const result = { ok: false, reason: 'timeout', idleMs: idleFor, working: s.working };
      if (wantJson) process.stdout.write(JSON.stringify(result) + '\n');
      else process.stderr.write(`timeout: still active after ${timeoutMs}ms (last ${idleFor}ms ago)\n`);
      process.exit(1);
    }
    await new Promise((r) => setTimeout(r, pollInterval));
  }
}

async function cmdAttach(id) {
  if (!id) fail('usage: pretty attach <id>  (Ctrl+Q to detach)');
  const WebSocket = (() => {
    try { return require(path.resolve(__dirname, '..', 'node_modules', 'ws')); }
    catch { fail('attach needs `ws` installed in prettyd/node_modules', 2); }
  })();
  const sock = new WebSocket(`ws://${HOST}:${PORT}/ws?sessionId=${encodeURIComponent(id)}`);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  const onStdin = (chunk) => {
    // Ctrl+Q (\x11) → detach without killing the session.
    if (chunk.includes(0x11)) {
      cleanup();
      return;
    }
    if (sock.readyState === sock.OPEN) {
      sock.send(JSON.stringify({ type: 'input', data: chunk.toString('utf8') }));
    }
  };
  function cleanup() {
    process.stdin.removeListener('data', onStdin);
    try { process.stdin.setRawMode(false); } catch {}
    process.stdin.pause();
    try { sock.close(); } catch {}
    process.exit(0);
  }
  sock.on('open', () => {
    const { rows, columns } = process.stdout;
    if (rows && columns) sock.send(JSON.stringify({ type: 'resize', cols: columns, rows }));
    process.stdin.on('data', onStdin);
  });
  sock.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (msg.type === 'output') process.stdout.write(msg.data);
    if (msg.type === 'exit') { process.stdout.write(`\n[session exited code=${msg.code ?? '∅'}]\n`); cleanup(); }
  });
  sock.on('close', () => cleanup());
  process.stdout.on('resize', () => {
    if (sock.readyState === sock.OPEN) {
      sock.send(JSON.stringify({ type: 'resize', cols: process.stdout.columns, rows: process.stdout.rows }));
    }
  });
}

function help() {
  process.stdout.write([
    'pretty — prettyd CLI',
    '',
    'Subcommands:',
    '  ls [-a | --include-exited]  list sessions (default: hides exited)',
    '  snap <id> [--raw]        print current buffer (default: clean text)',
    '  tail <id> [-f] [-n N]    print last N (default 50) lines; -f to follow',
    '  wait <id> [--idle Ns] [--timeout Ns]',
    '                           block until session has been idle for Ns',
    '                           (default --idle 2s, --timeout 30s)',
    '  send <id> <text...>      send text + Enter (alias: `input`)',
    '  input <id> <text...>     same as send',
    '  keys <id> <key>          send esc|up|down|left|right|^c|^d|enter|tab',
    '  new --tool <claude|codex|shell> [--cwd P] [--no-skip-perms] [extra args]',
    '  new [--cwd P] [--cmd C] [args...]',
    '                           create a session.  --tool is the easy path:',
    '                              pretty new --tool claude',
    '                              pretty new --tool claude --cwd ~/foo',
    '                              pretty new --tool codex --no-skip-perms',
    '                           or supply --cmd / a positional command directly.',
    '  kill <id> [<id>...]      terminate one or more sessions',
    '  attach <id>              raw two-way stream (Ctrl+Q to detach)',
    '  doctor                   per-session health: QoS (throttled?), spawn',
    '                           path (dist/tsx), flags sessions needing recreate',
    '',
    'Global flags:',
    '  --json   machine-friendly output',
    '  --host   prettyd host (default 127.0.0.1)',
    '  --port   prettyd port (default 8787)',
    ''
  ].join('\n'));
}

(async () => {
  switch (sub) {
    case 'ls': return cmdLs(argv);
    case 'snap': return cmdSnap(argv[0], argv.includes('--raw'));
    case 'send':
    case 'input':  // alias — same operation, more intuitive for agent loops
      return cmdSend(argv[0], argv.slice(1).join(' '));
    case 'keys': return cmdKeys(argv[0], argv[1]);
    case 'new':  return cmdNew(argv);
    case 'kill': return cmdKill(argv);
    case 'tail': return cmdTail(argv);
    case 'wait': return cmdWait(argv);
    case 'attach': return cmdAttach(argv[0]);
    case 'doctor': return cmdDoctor();
    case undefined:
    case 'help':
    case '--help':
    case '-h':
      return help();
    default:
      fail(`unknown command: ${sub}\n\nrun 'pretty help' for usage`);
  }
})().catch((err) => fail(err.message || String(err), 2));
