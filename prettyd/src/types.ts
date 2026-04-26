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

// Client → server WS messages.
export type ClientMsg =
  | { type: 'input'; data: string }
  | { type: 'resize'; cols: number; rows: number };

// Server → client WS messages.
// Output is sent as raw binary frames so xterm.js can write it directly
// without a JSON.parse hop on every chunk.
export type ServerMsg =
  | { type: 'hello'; session: SessionInfo }
  | { type: 'exit'; code: number | null; signal: string | null }
  | { type: 'error'; message: string };
