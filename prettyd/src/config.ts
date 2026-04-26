import os from 'node:os';

export const config = {
  host: process.env.PRETTYD_HOST ?? '127.0.0.1',
  port: Number(process.env.PRETTYD_PORT ?? 8787),
  defaultShell: process.env.SHELL ?? '/bin/bash',
  defaultCwd: process.env.HOME ?? os.homedir(),
  defaultCols: 120,
  defaultRows: 32
};
