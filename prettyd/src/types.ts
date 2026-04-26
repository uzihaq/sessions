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

// Wire-protocol version. Bump whenever message shapes change so a
// client can detect mismatch and refuse to render rather than silently
// rendering wrong data.
export const PROTOCOL_VERSION = 2;

// Client → server WS messages.
export type ClientMsg =
  | { type: 'input'; data: string }
  | { type: 'resize'; cols: number; rows: number };

// Server → client WS messages.
// Phase 2: every output chunk carries a monotonic seq#. Clients persist
// the last seen seq and reconnect with ?lastSeq=N to resume.
export type ServerMsg =
  | { type: 'hello'; protocol: number; session: SessionInfo; currentSeq: number; resumedFromSeq: number | null }
  | { type: 'output'; seq: number; data: string }
  | { type: 'gap'; oldestAvailableSeq: number; currentSeq: number }
  | { type: 'exit'; code: number | null; signal: string | null; seq: number }
  | { type: 'error'; message: string };
