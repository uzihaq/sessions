export type SessionTool = 'claude-code' | 'codex' | 'terminal';

export interface SessionInfo {
  id: string;
  cmd: string;
  args: string[];
  cwd: string;
  cols: number;
  rows: number;
  createdAt: number;
  pid: number;
  // Tool classification derived from cmd. Lets the UI tab strip show
  // the right icon for inactive sessions without polling each one.
  tool: SessionTool;
  // Cheap activity-based "working" signal so inactive tabs in the UI
  // can show a pulse without us running a parser per session. True if
  // the PTY emitted >=THRESHOLD bytes within the last WINDOW_MS (see
  // sessions.ts). Tool-agnostic — accurate enough that a Claude turn,
  // a bash log spam, or a `cat large.txt` all read as "working".
  working: boolean;
  lastDataAt: number; // ms epoch
  // Set when the PTY exits. Sessions stick around for 30s after EXIT
  // so the UI / `pretty ls --include-exited` can show what happened.
  exited: boolean;
  exitCode: number | null;
  exitSignal: string | null;
  exitedAt: number | null; // ms epoch when EXIT was received
  // Latest Claude-side titles pulled from the JSONL. /rename writes a
  // {type:"custom-title",customTitle:"..."} event; the auto-generated
  // summary writes {type:"ai-title",aiTitle:"..."}. Both undefined for
  // non-Claude sessions or before Claude has emitted them. Frontend
  // prefers customTitle > aiTitle > cwd-basename for the tab label,
  // and the user's manual rename overrides all of these.
  claudeCustomTitle?: string;
  claudeAiTitle?: string;
}

export function classifyTool(cmd: string): SessionTool {
  const c = cmd.toLowerCase();
  // Match either bare name (`claude`) or path-suffix (`/opt/homebrew/bin/claude`).
  if (c === 'claude' || c.endsWith('/claude')) return 'claude-code';
  if (c === 'codex' || c.endsWith('/codex')) return 'codex';
  return 'terminal';
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
  | {
      type: 'hello';
      protocol: number;
      session: SessionInfo;
      currentSeq: number;
      resumedFromSeq: number | null;
      // Server-side claudeEventLog length at hello time. Clients use
      // this to compute incremental indices for ?claudeEventsSince= on
      // their next reconnect.
      claudeEventsCount: number;
      // Index of the first event the server is about to replay. On
      // fresh connects against a long session, the server caps the
      // initial replay to the tail; the client should treat its local
      // claudeEvents counter as starting at this value, not 0.
      claudeReplayStart: number;
    }
  | { type: 'output'; seq: number; data: string }
  | { type: 'gap'; oldestAvailableSeq: number; currentSeq: number }
  | { type: 'exit'; code: number | null; signal: string | null; seq: number }
  | { type: 'error'; message: string }
  // Claude Code's structured session events, sourced from
  // ~/.claude/projects/<encoded-cwd>/<id>.jsonl. Frontend consumers
  // (currently Remote view) opt in to these instead of parsing the
  // PTY byte stream. Schema is the Anthropic API persistence format
  // — kept as a passthrough record because event shapes vary by
  // type ('user', 'assistant', 'system', etc.) and are decoded on
  // the frontend side.
  | { type: 'claudeEvent'; event: Record<string, unknown> };
