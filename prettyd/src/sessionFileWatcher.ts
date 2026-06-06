// Claude Code persists every session as a JSONL file in
// ~/.claude/projects/<encoded-cwd>/<claude-session-id>.jsonl. Each
// appended line is a typed event from the Anthropic API stream —
// user message, assistant message, tool call, tool result, system
// notice, etc. — with stable UUIDs and structured content.
//
// This watcher locates the JSONL for a running prettyd session (by
// matching encoded cwd + most-recent mtime), tails new lines, parses
// them, and emits the events for downstream consumers. Way more
// reliable than scraping the rendered TUI — every parsing bug we hit
// in lib/parser.ts ("Wraysbury misparsed as Bash tool", "❯ picker
// option as user_input", "API error not rendered", "blank line ends
// user message") simply doesn't exist with JSONL — the role, content,
// and error fields are explicit.
//
// Read-only: we only consume events; input dispatch still goes
// through the PTY (which is the only writable side).

import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';

// Anthropic's persisted event format. Conservatively typed — we only
// pluck out the fields downstream actually uses; everything else is
// passed through as opaque.
export interface ClaudeSessionEvent {
  type: string;            // 'user' | 'assistant' | 'system' | 'permission-mode' | ...
  uuid?: string;           // stable message id
  parentUuid?: string | null;
  timestamp?: string;      // ISO 8601
  sessionId?: string;      // Claude's session id (NOT prettyd's)
  message?: {
    role?: string;
    content?: unknown;     // string OR array of typed blocks
    model?: string;
    stop_reason?: string;
    usage?: unknown;
  };
  // pass-through for anything else (snapshot events, permission-mode
  // changes, file-history snapshots, queue operations, etc.)
  [key: string]: unknown;
}

// Convert a cwd path like /Users/uzair/Projects/rail-me into Claude's
// directory-name encoding: "-Users-uzair-Projects-rail-me". Every '/'
// becomes '-'.
function encodeCwd(cwd: string): string {
  return cwd.replace(/\//g, '-');
}

function projectDirFor(cwd: string): string {
  return path.join(os.homedir(), '.claude', 'projects', encodeCwd(cwd));
}

interface WatcherOptions {
  cwd: string;
  // Claude session UUID we explicitly passed via `--session-id <uuid>`
  // (or `--resume <uuid>`) at spawn. The JSONL filename IS this uuid
  // plus ".jsonl". REQUIRED — without it there's no way to identify
  // the right file. Non-Claude sessions shouldn't be instantiating
  // this watcher in the first place.
  claudeSessionId?: string;
  // Delay before first lookup attempt — Claude takes ~1s to write its
  // initial JSONL after spawn. Default 1500ms.
  initialDelayMs?: number;
  // How often to retry locating the JSONL if it's not there yet.
  pollIntervalMs?: number;
  // Max wait before giving up the initial location search.
  maxWaitMs?: number;
}

// Public: watch a session's JSONL and emit each parsed event.
// Caller listens on 'event' (one per JSONL line) and on 'error' (rare).
// Returns an EventEmitter + close() that detaches everything.
//
// The watcher tails the file from byte 0 on first attach (caller can
// filter historical vs live events by checking the event's timestamp
// against now), and uses fs.watch + fs.stat for new-data detection.
// chokidar would also work but is a heavier dep — fs.watch on a
// single file is fine for our scale.
export interface SessionFileWatcher {
  readonly emitter: EventEmitter;
  readonly path: () => string | null;
  close(): void;
}

export async function watchSessionFile(opts: WatcherOptions): Promise<SessionFileWatcher> {
  const emitter = new EventEmitter();
  emitter.setMaxListeners(64);
  let closed = false;
  let currentPath: string | null = null;
  let watcher: fs.FSWatcher | null = null;
  let readOffset = 0;
  let lineBuffer = '';
  let readingInFlight = false;
  let pendingRead = false;
  const initialDelayMs = opts.initialDelayMs ?? 1500;
  const pollIntervalMs = opts.pollIntervalMs ?? 1000;
  const maxWaitMs = opts.maxWaitMs ?? 30_000;

  const attachFile = (filePath: string): void => {
    currentPath = filePath;
    readOffset = 0;
    lineBuffer = '';
    // Initial read of whatever's already there.
    void readAppended();
    // fs.watch fires 'change' on appends. We re-read from readOffset.
    try {
      watcher = fs.watch(filePath, { persistent: false }, (eventType) => {
        if (closed) return;
        if (eventType === 'rename') {
          // File was renamed/removed — Claude rotated. We could try
          // to re-locate but for now just close. The caller can
          // re-establish on next session create if needed.
          close();
          return;
        }
        void readAppended();
      });
    } catch (err) {
      emitter.emit('error', err);
    }
  };

  // Coalesce overlapping reads: if we're already reading, queue one
  // more and bail. After the in-flight read finishes, drain pending.
  const readAppended = async (): Promise<void> => {
    if (closed || !currentPath) return;
    if (readingInFlight) {
      pendingRead = true;
      return;
    }
    readingInFlight = true;
    try {
      let st: fs.Stats;
      try {
        st = await fsp.stat(currentPath);
      } catch {
        return;
      }
      if (st.size < readOffset) {
        // File was truncated/replaced. Restart from 0.
        readOffset = 0;
        lineBuffer = '';
      }
      if (st.size <= readOffset) return;
      const buf = Buffer.alloc(st.size - readOffset);
      const fh = await fsp.open(currentPath, 'r');
      try {
        await fh.read(buf, 0, buf.length, readOffset);
      } finally {
        await fh.close();
      }
      readOffset = st.size;
      lineBuffer += buf.toString('utf8');
      let nl: number;
      while ((nl = lineBuffer.indexOf('\n')) !== -1) {
        const line = lineBuffer.slice(0, nl);
        lineBuffer = lineBuffer.slice(nl + 1);
        if (!line.trim()) continue;
        let parsed: ClaudeSessionEvent;
        try {
          parsed = JSON.parse(line) as ClaudeSessionEvent;
        } catch {
          continue; // ignore malformed lines
        }
        emitter.emit('event', parsed);
      }
    } finally {
      readingInFlight = false;
      if (pendingRead && !closed) {
        pendingRead = false;
        void readAppended();
      }
    }
  };

  const close = (): void => {
    if (closed) return;
    closed = true;
    try { watcher?.close(); } catch { /* ignore */ }
    watcher = null;
  };

  // Find the JSONL by exact session-id match. Claude takes ~1s to
  // create the file after spawn; we poll until the deadline.
  //
  // Deliberately NO mtime/birthtime fallback. The old "newest .jsonl
  // in this project dir" heuristic was a leftover from before we
  // started passing --session-id deterministically for every Claude
  // session we launch. It had no correct case and at least one
  // actively wrong case: two Claudes open in the same folder (common
  // — users start multiple sessions in /Users/<n>/Projects) → the
  // fallback locks onto whichever was most recently active, which is
  // by definition the OTHER session. Both prettyd tabs end up tailing
  // the same JSONL, both Pretty panes show the same conversation,
  // and the user has no way to tell.
  //
  // The right failure mode if Claude never writes its JSONL is "Pretty
  // pane stays empty" — not "Pretty pane shows an unrelated random
  // conversation."
  void (async () => {
    await new Promise((r) => setTimeout(r, initialDelayMs));
    if (!opts.claudeSessionId) {
      // No session id passed — non-Claude session or pre-deterministic-id
      // legacy caller. Nothing to attach to; bail out quietly.
      return;
    }
    const knownPath = path.join(projectDirFor(opts.cwd), `${opts.claudeSessionId}.jsonl`);
    const deadline = Date.now() + maxWaitMs;
    while (!closed && Date.now() < deadline) {
      try {
        await fsp.stat(knownPath);
        attachFile(knownPath);
        return;
      } catch {
        await new Promise((r) => setTimeout(r, pollIntervalMs));
      }
    }
    if (!closed) {
      emitter.emit('error', new Error(`no .jsonl found for session ${opts.claudeSessionId} in ${projectDirFor(opts.cwd)}`));
    }
  })();

  return {
    emitter,
    path: () => currentPath,
    close
  };
}
