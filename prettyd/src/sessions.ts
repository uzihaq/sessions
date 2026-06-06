import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { config } from './config.js';
import { EventLog, type OutputEvent } from './eventLog.js';
import { RunnerClient } from './runnerClient.js';
import { classifyTool } from './types.js';
import { bootstrapRunner, bootoutRunner, cleanupOrphanPlists } from './launchd.js';
import type { CreateSessionRequest, SessionInfo } from './types.js';
import { watchSessionFile, type SessionFileWatcher, type ClaudeSessionEvent } from './sessionFileWatcher.js';

// Same trick runner.ts uses to bypass @xterm/headless's broken ESM facade.
const xtermRequire = createRequire(import.meta.url);
const { Terminal } = xtermRequire('@xterm/headless') as typeof import('@xterm/headless');
const { SerializeAddon } = xtermRequire('@xterm/addon-serialize') as typeof import('@xterm/addon-serialize');

type HeadlessTerminal = InstanceType<typeof Terminal>;
type HeadlessSerializeAddon = InstanceType<typeof SerializeAddon>;

interface SessionInternal {
  info: SessionInfo;
  client: RunnerClient;
  emitter: EventEmitter;
  log: EventLog;
  // Server-side xterm-headless mirror, fed from the same OUTPUT stream
  // the EventLog consumes. Snapshots serialize from this so the result
  // includes scrollback even when the runner subprocess is locked at
  // scrollback:0 by an old code version (e.g. fit-furniture's runner
  // started before the snapshot:scrollback bump). Memory cost is one
  // additional headless terminal per session; with scrollback 5000 ×
  // ~120-300 cols that's a few MB worst case.
  mirrorTerm: HeadlessTerminal;
  mirrorSerialize: HeadlessSerializeAddon;
  exited: boolean;
  exitCode: number | null;
  exitSignal: string | null;
  exitSeq: number | null;
  recentBytes: number;
  // JSONL watcher for Claude Code sessions. Reads structured events
  // from ~/.claude/projects/<encoded-cwd>/<id>.jsonl and re-emits
  // through `emitter.emit('claudeEvent', ev)`. Null for non-Claude
  // sessions or before Claude initializes its session file.
  fileWatcher: SessionFileWatcher | null;
  // History of events seen so far on this session. Lets new WS
  // connections replay everything Claude has emitted since this
  // prettyd started, same shape as how OutputEvent replay works.
  claudeEventLog: ClaudeSessionEvent[];
}

export type { OutputEvent };
export type SessionHandle = SessionInternal;

const STATE_DIR = process.env.PRETTYD_STATE_DIR
  ?? path.join(os.homedir(), '.local', 'state', 'pretty-PTY', 'runners');

const sessions = new Map<string, SessionInternal>();

const WORKING_BYTES_THRESHOLD = 80;
const WORKING_DECAY_MS = 800;
// How long an exited session stays visible to /api/sessions before being
// dropped. Lets `pretty ls --include-exited` and the UI tab strip show
// "exit code 0" briefly without showing ghost sessions forever.
const EXITED_GRACE_MS = 30_000;

setInterval(() => {
  for (const s of sessions.values()) {
    if (s.exited) continue;
    s.recentBytes = Math.floor(s.recentBytes / 2);
    s.info.working = s.recentBytes >= WORKING_BYTES_THRESHOLD;
  }
}, WORKING_DECAY_MS).unref();

// Locate the runner program arguments. Both dev (tsx) and prod (node)
// paths use process.execPath as argv[0] — that's the absolute path to
// the running node binary, which works under launchd's minimal PATH.
//
// Preference order:
//   1. runner.js next to this file (prod build — running from dist/).
//   2. ../dist/runner.js (dev: prettyd is launched via tsx-watch on
//      src/, but dist/ already has compiled artifacts from a prior
//      `npm run build`). Only used when dist is at least as fresh as
//      src — tsx-watch auto-rebuilds tsx code on save, so falling back
//      to a stale dist would launch new sessions on old code.
//   3. tsx + runner.ts — true dev, no build artifacts. Slow because
//      each new session pays the tsx cold-start cost (~30-60s).
// Pull the Claude session UUID out of the command-line args, looking
// for either `--session-id <uuid>` (we set this for fresh sessions)
// or `--resume <uuid>` (set when resuming a specific session). The
// uuid IS the JSONL filename, so the watcher can lock onto the right
// file deterministically.
function extractClaudeSessionId(args: string[]): string | undefined {
  for (let i = 0; i < args.length - 1; i++) {
    const flag = args[i];
    if (flag === '--session-id' || flag === '--resume') {
      const v = args[i + 1];
      if (typeof v === 'string' && /^[0-9a-f-]{8,}$/i.test(v)) return v;
    }
  }
  return undefined;
}

function resolveRunnerProgramArguments(): string[] {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const sideBySide = path.join(here, 'runner.js');
  if (fs.existsSync(sideBySide)) {
    return [process.execPath, sideBySide];
  }
  const tsPath = path.join(here, 'runner.ts');
  const distSibling = path.join(here, '..', 'dist', 'runner.js');
  if (fs.existsSync(distSibling) && fs.existsSync(tsPath)) {
    try {
      const distMtime = fs.statSync(distSibling).mtimeMs;
      const srcMtime = fs.statSync(tsPath).mtimeMs;
      if (distMtime >= srcMtime) {
        return [process.execPath, distSibling];
      }
    } catch {
      // fall through to tsx
    }
  }
  if (fs.existsSync(tsPath)) {
    const tsxBin = path.join(here, '..', 'node_modules', '.bin', 'tsx');
    if (!fs.existsSync(tsxBin)) {
      throw new Error(`runner needs tsx but ${tsxBin} not found; run npm install in prettyd/`);
    }
    return [process.execPath, tsxBin, tsPath];
  }
  throw new Error(`runner not found near ${here}`);
}

export async function createSession(req: CreateSessionRequest): Promise<SessionInfo> {
  const id = randomUUID();
  const cmd = req.cmd ?? config.defaultShell;
  const args = req.args ?? [];
  const cwd = req.cwd ?? config.defaultCwd;
  const cols = req.cols ?? config.defaultCols;
  const rows = req.rows ?? config.defaultRows;

  // Surface a useful error early when the user typed a cwd that doesn't
  // exist (deleted folder, moved project, typo). Without this guard,
  // launchd happily starts the runner, the runner's spawn() of bash/
  // claude/etc. fails because the cwd is invalid, the runner exits
  // before binding its socket, and the user sees a useless 15-second
  // "runner did not create socket" timeout — exactly how I just lost
  // 15 minutes hunting for the wrong bug.
  try {
    const st = fs.statSync(cwd);
    if (!st.isDirectory()) {
      throw new Error(`cwd is not a directory: ${cwd}`);
    }
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === 'ENOENT') {
      throw new Error(`cwd does not exist: ${cwd}`);
    }
    throw err;
  }

  fs.mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
  const sockPath = path.join(STATE_DIR, id + '.sock');
  const logPath = path.join(STATE_DIR, id + '.log');

  // launchd starts the runner with a minimal env. We pass everything the
  // runner expects via EnvironmentVariables in the plist. Crucially we
  // include a sane PATH so the actual PTY command (e.g. `claude`) can be
  // found by node-pty's spawn — without this, brew-installed binaries
  // fall off the path under launchd.
  const launchdEnv: Record<string, string> = {
    HOME: process.env.HOME || os.homedir(),
    USER: process.env.USER || '',
    PATH: process.env.PATH || '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin',
    LANG: process.env.LANG || 'en_US.UTF-8',
    SHELL: process.env.SHELL || '/bin/bash',
    TERM: 'xterm-256color',
    RUNNER_ID: id,
    RUNNER_STATE_DIR: STATE_DIR,
    RUNNER_CMD: cmd,
    RUNNER_ARGS_JSON: JSON.stringify(args),
    RUNNER_CWD: cwd,
    RUNNER_COLS: String(cols),
    RUNNER_ROWS: String(rows),
    ...(req.env ?? {})
  };

  const programArguments = resolveRunnerProgramArguments();
  const ok = bootstrapRunner({
    id,
    programArguments,
    env: launchdEnv,
    cwd,
    logPath
  });
  if (!ok) {
    throw new Error(`launchctl bootstrap failed for ${id} — see ${logPath}`);
  }

  // launchd's bootstrap is synchronous in the load step but the runner
  // process initializes asynchronously. The cold-start budget includes
  // tsx-loader + node-pty + xterm-headless + the actual `claude`
  // binary's own startup. With a built dist/runner.js (preferred path
  // above) this lands in 2-3s; falling back to tsx adds another
  // 20-40s easily on a cold cache. 60s gives both paths headroom and
  // mirrors what `pretty new` accepts.
  const RUNNER_BOOT_MS = 60_000;
  const usingTsx = programArguments.some((p) => p.endsWith('/tsx'));
  const deadline = Date.now() + RUNNER_BOOT_MS;
  while (!fs.existsSync(sockPath)) {
    if (Date.now() > deadline) {
      // Don't immediately bootout — leave the plist behind so we can
      // inspect what launchd is doing. (Caller can launchctl print to
      // see the service state, view the runner log, etc.) The orphan-
      // cleanup pass on next prettyd start will reap it eventually.
      // Hint at the actual bottleneck so the user knows to rebuild.
      const hint = usingTsx
        ? ' Try `npm --prefix prettyd run build` so future sessions skip tsx cold-start.'
        : '';
      throw new Error(
        `runner did not create socket within ${RUNNER_BOOT_MS / 1000}s: ${sockPath} (see ${logPath}).${hint}`
      );
    }
    await new Promise((r) => setTimeout(r, 30));
  }

  const session = await registerRunner(sockPath);
  return session.info;
}

// Connect to an existing runner socket and register it as a session.
// Used both for newly-spawned runners (createSession) and for survivors
// discovered on prettyd startup.
async function registerRunner(sockPath: string): Promise<SessionInternal> {
  const client = new RunnerClient(sockPath);
  const hello = await client.connect();

  // Mirror the runner's event log locally so WS replay is in-memory.
  // Pull whatever the runner already has via REPLAY_REQ(0) before going
  // live. New OUTPUT frames append automatically.
  const log = new EventLog();
  const emitter = new EventEmitter();
  emitter.setMaxListeners(64);
  // Server-side xterm mirror (see SessionInternal). Sized to the PTY's
  // hello-reported cols/rows + 5000 rows scrollback (matches the runner
  // for parity). Built before client.on('output') is wired so the very
  // first replay event lands in both EventLog AND mirror.
  const mirrorTerm = new Terminal({
    cols: hello.cols,
    rows: hello.rows,
    scrollback: 5000,
    allowProposedApi: true
  });
  const mirrorSerialize = new SerializeAddon();
  mirrorTerm.loadAddon(mirrorSerialize);
  const internal: SessionInternal = {
    info: {
      id: hello.id,
      cmd: hello.cmd,
      args: hello.args,
      cwd: hello.cwd,
      cols: hello.cols,
      rows: hello.rows,
      createdAt: hello.createdAt,
      pid: hello.pid,
      tool: classifyTool(hello.cmd),
      working: false,
      lastDataAt: Date.now(),
      exited: false,
      exitCode: null,
      exitSignal: null,
      exitedAt: null
    },
    client,
    emitter,
    log,
    mirrorTerm,
    mirrorSerialize,
    exited: false,
    exitCode: null,
    exitSignal: null,
    exitSeq: null,
    recentBytes: 0,
    fileWatcher: null,
    claudeEventLog: []
  };
  sessions.set(hello.id, internal);

  // Spin up the JSONL watcher for Claude Code sessions. The cwd is
  // the only thing needed to locate the project dir; the watcher
  // finds the actual .jsonl by most-recent mtime. Best-effort — if
  // it fails (not a Claude session, no JSONL written yet, etc.) we
  // silently keep going. The existing parser-derived path is still
  // available as a fallback.
  if (internal.info.tool === 'claude-code' && hello.cwd) {
    // Extract the Claude session UUID we explicitly pinned at spawn
    // (`--session-id <uuid>` for fresh, `--resume <uuid>` for resume).
    // This is now the ONLY way the watcher locates the JSONL — no
    // mtime/birthtime fallback. If it's missing, the watcher gives
    // up cleanly and Pretty view stays empty (which is the correct
    // failure mode for a session we don't have an id for).
    const claudeSessionId = extractClaudeSessionId(hello.args);
    void watchSessionFile({
      cwd: hello.cwd,
      claudeSessionId
    })
      .then((watcher) => {
        if (internal.exited) {
          watcher.close();
          return;
        }
        internal.fileWatcher = watcher;
        watcher.emitter.on('event', (ev: ClaudeSessionEvent) => {
          internal.claudeEventLog.push(ev);
          // Bound the log so a long-running session doesn't grow
          // unbounded. 5000 events ≈ several days of typical use.
          if (internal.claudeEventLog.length > 5000) {
            internal.claudeEventLog.splice(0, internal.claudeEventLog.length - 5000);
          }
          // Surface Claude's own session titles. The TUI writes two
          // event types into the JSONL:
          //   {"type":"ai-title","aiTitle":"<auto-generated>","sessionId":...}
          //   {"type":"custom-title","customTitle":"<user via /rename>","sessionId":...}
          // We keep the most recent of each on the session info so the
          // frontend tab strip can match the official label without
          // shipping the whole event log. custom-title wins over
          // ai-title because /rename is explicit user intent.
          const t = (ev as { type?: string }).type;
          if (t === 'custom-title') {
            const v = (ev as { customTitle?: string }).customTitle;
            if (typeof v === 'string' && v.length > 0) internal.info.claudeCustomTitle = v;
          } else if (t === 'ai-title') {
            const v = (ev as { aiTitle?: string }).aiTitle;
            if (typeof v === 'string' && v.length > 0) internal.info.claudeAiTitle = v;
          }
          emitter.emit('claudeEvent', ev);
        });
        watcher.emitter.on('error', () => { /* swallow — non-fatal */ });
      })
      .catch(() => { /* swallow — non-fatal */ });
  }

  // Wire runner events.
  client.on('output', (ev) => {
    // Push to local mirror with the runner's seq so replays line up.
    log.pushAt(ev.seq, ev.data);
    // Feed the headless mirror so snapshot() can serialize w/ scrollback.
    try { mirrorTerm.write(ev.data); } catch { /* mirror write failed — non-fatal */ }
    internal.recentBytes += Buffer.byteLength(ev.data, 'utf8');
    internal.info.lastDataAt = Date.now();
    internal.info.working = internal.recentBytes >= WORKING_BYTES_THRESHOLD;
    emitter.emit('output', { seq: ev.seq, data: ev.data, ts: internal.info.lastDataAt } satisfies OutputEvent);
  });
  client.on('exit', (e) => {
    internal.exited = true;
    internal.exitCode = e.code;
    internal.exitSignal = e.signal;
    internal.exitSeq = e.seq;
    internal.info.exited = true;
    internal.info.exitCode = e.code;
    internal.info.exitSignal = e.signal;
    internal.info.exitedAt = Date.now();
    internal.info.working = false;
    emitter.emit('exit', { code: e.code, signal: e.signal, seq: e.seq });
    // Take launchd off the plist so it doesn't auto-restart this
    // session on next reboot. Best effort — if launchctl errors we
    // proceed; cleanupOrphanPlists on next prettyd start will catch it.
    try { bootoutRunner(hello.id); } catch { /* best effort */ }
    // Keep the session in the map for EXITED_GRACE_MS so `pretty ls
    // --include-exited`, `pretty ls --json`, and the UI's tab strip can
    // show what happened. The default `pretty ls` and the frontend's
    // tab list still hide them so kill feels immediate.
    setTimeout(() => {
      sessions.delete(hello.id);
      try { mirrorTerm.dispose(); } catch { /* ignore */ }
      try { internal.fileWatcher?.close(); } catch { /* ignore */ }
    }, EXITED_GRACE_MS).unref();
    client.disconnect();
  });
  client.on('disconnect', () => {
    // Socket dropped without a clean EXIT (runner crashed, or we got
    // here via the exit handler above). If we already saw EXIT, the
    // grace-period timer above will clean up. If not, drop now.
    if (!internal.exited) {
      sessions.delete(hello.id);
      try { mirrorTerm.dispose(); } catch { /* ignore */ }
    }
  });

  // Backfill from the runner's existing buffer.
  client.requestReplay(0);
  await new Promise<void>((resolve) => {
    const onDone = (): void => {
      client.off('replayDone', onDone);
      resolve();
    };
    client.on('replayDone', onDone);
  });

  return internal;
}

// Scan the runners state directory and reconnect to any that are still
// alive. Called once on prettyd startup. Stale .json + .sock pairs (where
// connect fails) are unlinked, and orphan launchd plists (whose state
// files are gone) are booted out so they don't auto-start next reboot.
export async function discoverRunners(): Promise<void> {
  // Boot out any launchd plists that point at runners with no state
  // files — those are leftovers from a runner that died unclean.
  cleanupOrphanPlists(STATE_DIR);
  if (!fs.existsSync(STATE_DIR)) return;
  let entries: string[];
  try { entries = fs.readdirSync(STATE_DIR); }
  catch { return; }
  const sockFiles = entries.filter((n) => n.endsWith('.sock'));
  for (const name of sockFiles) {
    const sockPath = path.join(STATE_DIR, name);
    const id = name.replace(/\.sock$/, '');
    const metaPath = path.join(STATE_DIR, id + '.json');
    // Try connecting up to 3 times with a small delay. The runner is
    // launchd-managed with KeepAlive(SuccessfulExit=false), so a dead
    // runner should be respawning RIGHT NOW. Give launchd a beat to
    // bring it back before we declare the session dead and bootout
    // its plist. Without this, every prettyd restart that races a
    // runner restart would nuke the plist and lose the session.
    let connected = false;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await registerRunner(sockPath);
        connected = true;
        break;
      } catch {
        if (attempt < 2) await new Promise((r) => setTimeout(r, 800));
      }
    }
    if (!connected) {
      // Genuinely dead after retries. Clean up so future starts don't
      // chase the same orphan.
      try { fs.unlinkSync(sockPath); } catch { /* ignore */ }
      try { fs.unlinkSync(metaPath); } catch { /* ignore */ }
      try { bootoutRunner(id); } catch { /* ignore */ }
    }
  }
}

export function listSessions(opts: { includeExited?: boolean } = {}): SessionInfo[] {
  const all = [...sessions.values()].map((s) => s.info);
  return opts.includeExited ? all : all.filter((s) => !s.exited);
}

export function getSession(id: string): SessionInternal | undefined {
  return sessions.get(id);
}

export function killSession(id: string): boolean {
  const s = sessions.get(id);
  if (!s) return false;
  s.client.kill();
  // Don't drop the session here — wait for the runner's EXIT frame.
  return true;
}

export function writeInput(id: string, data: string): boolean {
  const s = sessions.get(id);
  if (!s || s.exited) return false;
  s.client.send(data);
  return true;
}

export function resize(id: string, cols: number, rows: number): boolean {
  const s = sessions.get(id);
  if (!s || s.exited) return false;
  s.client.resize(cols, rows);
  s.info.cols = cols;
  s.info.rows = rows;
  return true;
}

export interface SnapshotResult {
  text: string;
  // Server seq# the snapshot represents — clients use this to resume
  // the WS subscription with `?lastSeq=N` so they only receive deltas
  // and don't re-process every frame from scratch through xterm.
  seq: number;
}

export async function snapshot(id: string, opts?: { cols?: number }): Promise<SnapshotResult | null> {
  const s = sessions.get(id);
  if (!s) return null;
  // Serialize from the prettyd-side mirror, not the runner. The mirror
  // is fed the same OUTPUT stream and stays at its own scrollback (5000),
  // so the result includes recent history regardless of what serialize
  // options the runner subprocess happens to use. This is what lets a
  // long-lived runner started with old code (e.g. fit-furniture's, on
  // scrollback:0) still produce useful Pretty-view snapshots.
  const raw = s.mirrorSerialize.serialize({ scrollback: 1000 });
  // The seq this snapshot represents = the latest seq mirrored. Subtle:
  // we read it AFTER serialize() so the value definitely reflects the
  // bytes that just got serialized; reading before could under-count
  // if a frame landed during serialization.
  const seq = s.log.currentSeq();
  if (opts?.cols && opts.cols > 0) {
    const { reflowAnsi } = await import('./reflow.js');
    return { text: reflowAnsi(raw, { width: opts.cols }), seq };
  }
  return { text: raw, seq };
}
