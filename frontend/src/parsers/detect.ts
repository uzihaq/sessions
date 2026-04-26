// Tool dispatcher. Checks each registered parser in order and returns
// the first one whose detect() matches. `terminalParser` is always last
// and its detect() always returns true, so there's always a match.
//
// App.tsx caches the result per session in a Map keyed by session name.
// The cache is invalidated when the cached parser's detect() stops
// matching (e.g. the user exited Claude Code and dropped back to a
// shell) so we can re-route to a different parser mid-session.

import type { ToolParser } from './types';
import { claudeCodeParser } from './claudeCode';
import { codexParser } from './codex';
import { terminalParser } from './terminal';

export const parsers: ToolParser[] = [
  claudeCodeParser,
  codexParser,
  terminalParser // always matches — must be last
];

export function detectTool(raw: string): ToolParser {
  for (const p of parsers) {
    if (p.detect(raw)) return p;
  }
  return terminalParser;
}

/**
 * Re-detect if the cached parser's signal is gone from the capture.
 * Returns the new parser (possibly the same one) — call-site should
 * swap only if `result.id !== cached.id`.
 */
export function redetectIfStale(cached: ToolParser, raw: string): ToolParser {
  // The terminal parser's detect() always returns true, so its "staleness"
  // check never fires — it holds its session forever unless the user
  // explicitly switches.
  if (cached.id === terminalParser.id) return cached;
  if (cached.detect(raw)) return cached;
  return detectTool(raw);
}
