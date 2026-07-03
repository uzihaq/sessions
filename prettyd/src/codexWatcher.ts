// Tail Codex rollout JSONL and normalize each rollout item into the
// canonical Claude-shaped event stream consumed by the rest of prettyd.
//
// Read-only: input still goes through the PTY. This watcher only follows
// ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl and emits normalized
// events through the same `claudeEvent` plumbing Claude Code uses.

import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import type { SessionFileWatcher, ClaudeSessionEvent } from './sessionFileWatcher.js';
import { normalizeCodexRolloutLine } from './codexNormalize.js';
import { codexWatchDirs, resolveCodexRolloutPath } from './codexResolver.js';

interface WatcherOptions {
  cwd: string;
  args: string[];
  createdAt: number;
  initialDelayMs?: number;
  pollIntervalMs?: number;
}

const EMIT_CAP = 60_000;
const EMIT_TRIM_TO = 40_000;

export async function watchCodexRollout(opts: WatcherOptions): Promise<SessionFileWatcher> {
  const emitter = new EventEmitter();
  emitter.setMaxListeners(64);

  const initialDelayMs = opts.initialDelayMs ?? 800;
  const pollIntervalMs = opts.pollIntervalMs ?? 2000;

  let closed = false;
  let currentPath: string | null = null;
  let currentIno: number | null = null;
  let readOffset = 0;
  let lineBuffer = '';
  let decoder = new StringDecoder('utf8');
  let lineIndex = 0;
  let readingInFlight = false;
  let pendingRead = false;

  const dirWatchers = new Map<string, fs.FSWatcher>();
  let fileWatcher: fs.FSWatcher | null = null;
  let pollTimer: NodeJS.Timeout | null = null;
  let tickScheduled = false;
  let ambiguityWarnedFor: string | null = null;

  const emitted = new Set<string>();
  const trimEmitted = (): void => {
    if (emitted.size <= EMIT_CAP) return;
    const keep = Array.from(emitted).slice(emitted.size - EMIT_TRIM_TO);
    emitted.clear();
    for (const u of keep) emitted.add(u);
  };

  const detachFileWatcher = (): void => {
    try { fileWatcher?.close(); } catch { /* ignore */ }
    fileWatcher = null;
  };

  const emitNormalized = (ev: ClaudeSessionEvent): void => {
    const uuid = typeof ev.uuid === 'string' ? ev.uuid : null;
    if (uuid) {
      if (emitted.has(uuid)) return;
      emitted.add(uuid);
      trimEmitted();
    }
    emitter.emit('event', ev);
  };

  const readFrom = async (): Promise<void> => {
    if (closed || !currentPath) return;
    if (readingInFlight) { pendingRead = true; return; }
    readingInFlight = true;
    try {
      let st: fs.Stats;
      try {
        st = await fsp.stat(currentPath);
      } catch {
        detachFileWatcher();
        currentPath = null; currentIno = null; readOffset = 0; lineBuffer = '';
        lineIndex = 0;
        decoder = new StringDecoder('utf8');
        return;
      }
      if ((currentIno !== null && st.ino !== currentIno) || st.size < readOffset) {
        readOffset = 0;
        lineBuffer = '';
        lineIndex = 0;
        decoder = new StringDecoder('utf8');
      }
      currentIno = st.ino;
      if (st.size <= readOffset) return;
      const buf = Buffer.alloc(st.size - readOffset);
      const fh = await fsp.open(currentPath, 'r');
      try {
        await fh.read(buf, 0, buf.length, readOffset);
      } finally {
        await fh.close();
      }
      readOffset = st.size;
      lineBuffer += decoder.write(buf);
      const rolloutBasename = path.basename(currentPath);
      let nl: number;
      while ((nl = lineBuffer.indexOf('\n')) !== -1) {
        const line = lineBuffer.slice(0, nl);
        lineBuffer = lineBuffer.slice(nl + 1);
        const thisLineIndex = lineIndex;
        lineIndex += 1;
        if (!line.trim()) continue;
        let parsed: unknown;
        try {
          parsed = JSON.parse(line) as unknown;
        } catch {
          continue;
        }
        const normalized = normalizeCodexRolloutLine(parsed, {
          rolloutBasename,
          lineIndex: thisLineIndex
        });
        for (const ev of normalized.events) emitNormalized(ev);
        if (normalized.working !== null) emitter.emit('working', normalized.working);
      }
    } finally {
      readingInFlight = false;
      if (pendingRead && !closed) {
        pendingRead = false;
        void readFrom();
      }
    }
  };

  const attachFile = (p: string): void => {
    if (currentPath === p) return;
    detachFileWatcher();
    currentPath = p;
    currentIno = null;
    readOffset = 0;
    lineBuffer = '';
    lineIndex = 0;
    decoder = new StringDecoder('utf8');
    ensureDirWatch(path.dirname(p));
    try {
      fileWatcher = fs.watch(p, { persistent: false }, (eventType) => {
        if (closed) return;
        if (eventType === 'rename') {
          detachFileWatcher();
          scheduleTick();
          return;
        }
        void readFrom();
      });
    } catch {
      // Polling still tails the file if fs.watch cannot attach.
    }
    void readFrom();
  };

  const ensureDirWatch = (dir: string): void => {
    if (closed || dirWatchers.has(dir)) return;
    try {
      const watcher = fs.watch(dir, { persistent: false }, () => {
        if (closed) return;
        scheduleTick();
      });
      dirWatchers.set(dir, watcher);
    } catch {
      // Directory may not exist yet; poll will retry after Codex creates it.
    }
  };

  const ensureDirWatches = (): void => {
    for (const dir of codexWatchDirs()) ensureDirWatch(dir);
    if (currentPath) ensureDirWatch(path.dirname(currentPath));
  };

  const tick = async (): Promise<void> => {
    if (closed) return;
    ensureDirWatches();
    const res = resolveCodexRolloutPath({
      cwd: opts.cwd,
      args: opts.args,
      createdAt: opts.createdAt
    });
    if (res.path) {
      if (res.ambiguousCount && ambiguityWarnedFor !== res.path) {
        ambiguityWarnedFor = res.path;
        console.warn(
          `[codex-rollout] ambiguous fresh session for ${opts.cwd}; using ${path.basename(res.path)} among ${res.ambiguousCount} cwd matches`
        );
      }
      if (currentPath === null) {
        attachFile(res.path);
      } else if (currentPath !== res.path && res.reason === 'resume-match') {
        attachFile(res.path);
      }
    }
    await readFrom();
  };

  const scheduleTick = (): void => {
    if (tickScheduled || closed) return;
    tickScheduled = true;
    setTimeout(() => {
      tickScheduled = false;
      void tick();
    }, 100);
  };

  const close = (): void => {
    if (closed) return;
    closed = true;
    for (const watcher of dirWatchers.values()) {
      try { watcher.close(); } catch { /* ignore */ }
    }
    dirWatchers.clear();
    detachFileWatcher();
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  };

  setTimeout(() => { if (!closed) void tick(); }, initialDelayMs);
  pollTimer = setInterval(() => { if (!closed) void tick(); }, pollIntervalMs);
  pollTimer.unref();

  return {
    emitter,
    path: () => currentPath,
    close
  };
}
