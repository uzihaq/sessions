import os from 'node:os';

export const config = {
  host: process.env.PRETTYD_HOST ?? '127.0.0.1',
  port: Number(process.env.PRETTYD_PORT ?? 8787),
  defaultShell: process.env.SHELL ?? '/bin/bash',
  defaultCwd: process.env.HOME ?? os.homedir(),
  // Fixed PTY size, never client-resized. The PTY is the canonical
  // wide buffer; every client fetches snapshots reflowed (server-side,
  // ANSI-aware) to its own viewport width. 300 cols is wide enough
  // that Claude Code / Codex draw their TUIs without compromise (long
  // file names, wide tables, ascii diagrams) and the reflow engine
  // wraps prose down to whatever the client actually has on screen.
  // 50 rows gives a generous live viewport without bloating snapshots.
  defaultCols: 300,
  defaultRows: 50
};
