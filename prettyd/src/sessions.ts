import { randomUUID } from 'node:crypto';
import { spawn, type IPty } from 'node-pty';
import { EventEmitter } from 'node:events';
import { config } from './config.js';
import { EventLog, type OutputEvent } from './eventLog.js';
import type { CreateSessionRequest, SessionInfo } from './types.js';

interface SessionInternal {
  info: SessionInfo;
  pty: IPty;
  emitter: EventEmitter;
  log: EventLog;
  exited: boolean;
  exitCode: number | null;
  exitSignal: string | null;
  exitSeq: number | null;
}

export type { OutputEvent };
export type SessionHandle = SessionInternal;

const sessions = new Map<string, SessionInternal>();

export function createSession(req: CreateSessionRequest): SessionInfo {
  const id = randomUUID();
  const cmd = req.cmd ?? config.defaultShell;
  const args = req.args ?? [];
  const cwd = req.cwd ?? config.defaultCwd;
  const cols = req.cols ?? config.defaultCols;
  const rows = req.rows ?? config.defaultRows;

  // Pass the parent env through so $PATH, $HOME, $SHELL etc. are available
  // inside the session. Caller-supplied env vars override.
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    ...(req.env ?? {}),
    TERM: 'xterm-256color',
    COLORTERM: 'truecolor'
  };

  const pty = spawn(cmd, args, { name: 'xterm-256color', cols, rows, cwd, env });

  const info: SessionInfo = {
    id,
    cmd,
    args,
    cwd,
    cols,
    rows,
    createdAt: Date.now(),
    pid: pty.pid
  };

  const emitter = new EventEmitter();
  // Higher than default — subscribers + an exit listener per WS, plus we
  // don't want noisy warnings if someone mashes "reconnect" rapidly.
  emitter.setMaxListeners(64);
  const internal: SessionInternal = {
    info,
    pty,
    emitter,
    log: new EventLog(),
    exited: false,
    exitCode: null,
    exitSignal: null,
    exitSeq: null
  };
  sessions.set(id, internal);

  pty.onData((data) => {
    const ev = internal.log.push(data);
    emitter.emit('output', ev);
  });
  pty.onExit(({ exitCode, signal }) => {
    internal.exited = true;
    internal.exitCode = exitCode;
    internal.exitSignal = typeof signal === 'number' ? String(signal) : (signal ?? null);
    internal.exitSeq = internal.log.currentSeq();
    emitter.emit('exit', {
      code: internal.exitCode,
      signal: internal.exitSignal,
      seq: internal.exitSeq
    });
  });

  return info;
}

export function listSessions(): SessionInfo[] {
  return [...sessions.values()].map((s) => s.info);
}

export function getSession(id: string): SessionInternal | undefined {
  return sessions.get(id);
}

export function killSession(id: string): boolean {
  const s = sessions.get(id);
  if (!s) return false;
  try {
    s.pty.kill();
  } catch {
    // already dead
  }
  sessions.delete(id);
  return true;
}

export function writeInput(id: string, data: string): boolean {
  const s = sessions.get(id);
  if (!s || s.exited) return false;
  s.pty.write(data);
  return true;
}

export function resize(id: string, cols: number, rows: number): boolean {
  const s = sessions.get(id);
  if (!s || s.exited) return false;
  s.pty.resize(cols, rows);
  s.info.cols = cols;
  s.info.rows = rows;
  return true;
}
