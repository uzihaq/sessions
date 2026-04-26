import { randomUUID } from 'node:crypto';
import { spawn, type IPty } from 'node-pty';
import { EventEmitter } from 'node:events';
import { config } from './config.js';
import type { CreateSessionRequest, SessionInfo } from './types.js';

interface SessionInternal {
  info: SessionInfo;
  pty: IPty;
  emitter: EventEmitter;
  exited: boolean;
  exitCode: number | null;
  exitSignal: string | null;
}

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
  const internal: SessionInternal = {
    info,
    pty,
    emitter,
    exited: false,
    exitCode: null,
    exitSignal: null
  };
  sessions.set(id, internal);

  pty.onData((data) => {
    emitter.emit('data', data);
  });
  pty.onExit(({ exitCode, signal }) => {
    internal.exited = true;
    internal.exitCode = exitCode;
    internal.exitSignal = typeof signal === 'number' ? String(signal) : (signal ?? null);
    emitter.emit('exit', { code: internal.exitCode, signal: internal.exitSignal });
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
