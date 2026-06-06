// Mirror of prettyd/src/types.ts. Kept duplicated for now to avoid
// bundling backend code into the browser; Phase 4 will move shared
// protocol types into a shared/ package once the daemon goes prod.

export const PROTOCOL_VERSION = 2;

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
  tool: SessionTool;
  working: boolean;
  lastDataAt: number;
  exited: boolean;
  exitCode: number | null;
  exitSignal: string | null;
  exitedAt: number | null;
  // Claude-side session titles, surfaced from the JSONL by prettyd.
  // claudeCustomTitle: set by Claude's /rename slash command.
  // claudeAiTitle: Claude's own auto-generated summary.
  // Used by the tab strip when the user hasn't manually renamed in
  // pretty-PTY itself (manual override always wins).
  claudeCustomTitle?: string;
  claudeAiTitle?: string;
}

export interface CreateSessionRequest {
  cmd?: string;
  args?: string[];
  cwd?: string;
  cols?: number;
  rows?: number;
  env?: Record<string, string>;
}

export interface DirectoryCandidate {
  path: string;
  label: string;
  kind: 'home' | 'common' | 'project';
}

export type ServerMsg =
  | {
      type: 'hello';
      protocol: number;
      session: SessionInfo;
      currentSeq: number;
      resumedFromSeq: number | null;
      // Index into the server's claudeEventLog at hello time. Clients
      // increment locally for each live claudeEvent received and pass
      // the running total as ?claudeEventsSince= on reconnect to skip
      // events they already have.
      claudeEventsCount: number;
      // Index of the first event in the upcoming initial replay. Use
      // this (not 0) as the starting point for the local counter —
      // on long sessions the server caps initial replay to the tail.
      claudeReplayStart: number;
    }
  | { type: 'output'; seq: number; data: string }
  | { type: 'gap'; oldestAvailableSeq: number; currentSeq: number }
  | { type: 'exit'; code: number | null; signal: string | null; seq: number }
  | { type: 'error'; message: string }
  // Claude Code's structured session events. Sourced server-side from
  // ~/.claude/projects/<encoded-cwd>/<id>.jsonl. RemoteView consumes
  // these instead of the parser-derived blocks — far more reliable
  // because the schema is the Anthropic API persistence format
  // (stable UUIDs, typed roles, structured content) rather than
  // regex-scraped TUI rendering.
  | { type: 'claudeEvent'; event: ClaudeSessionEvent };

// Anthropic's persisted session event. Conservatively typed — we read
// `type` and `message.*` for chat purposes; everything else is opaque.
export interface ClaudeSessionEvent {
  type: string;            // 'user' | 'assistant' | 'system' | …
  uuid?: string;
  parentUuid?: string | null;
  timestamp?: string;
  sessionId?: string;      // Claude's id, NOT prettyd's
  message?: {
    role?: string;
    content?: unknown;     // string OR array of typed blocks
    model?: string;
    stop_reason?: string;
    usage?: unknown;
  };
  [key: string]: unknown;
}
