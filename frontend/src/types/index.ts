// Mirror of prettyd/src/types.ts. Kept duplicated for now to avoid
// bundling backend code into the browser; Phase 4 will move shared
// protocol types into a shared/ package once the daemon goes prod.

export const PROTOCOL_VERSION = 2;

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

export type ServerMsg =
  | { type: 'hello'; protocol: number; session: SessionInfo; currentSeq: number; resumedFromSeq: number | null }
  | { type: 'output'; seq: number; data: string }
  | { type: 'gap'; oldestAvailableSeq: number; currentSeq: number }
  | { type: 'exit'; code: number | null; signal: string | null; seq: number }
  | { type: 'error'; message: string };
