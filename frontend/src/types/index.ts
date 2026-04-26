// Mirror of prettyd/src/types.ts. Kept duplicated for now to avoid
// bundling backend code into the browser; Phase 2 will move shared
// protocol types into a shared/ package.

export interface SessionInfo {
  id: string;
  cmd: string;
  args: string[];
  cwd: string;
  cols: number;
  rows: number;
  createdAt: number;
  pid: number;
}

export interface CreateSessionRequest {
  cmd?: string;
  args?: string[];
  cwd?: string;
  cols?: number;
  rows?: number;
  env?: Record<string, string>;
}

export type ServerCtrlMsg =
  | { type: 'hello'; session: SessionInfo }
  | { type: 'exit'; code: number | null; signal: string | null }
  | { type: 'error'; message: string };
