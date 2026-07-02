// Sidebar state derived from canonical Claude-shaped session events.
//
// Replaces the parser-derived sidebar (usePrettyParser → SidebarFindings).
// The parser had to scrape Claude's TUI redraws for timer/tokens/files/
// todos, which gave flicky timing — checklist counters wouldn't update
// until the next thinking_active redraw, the timer could disagree with
// what Claude itself was showing, etc.
//
// Stable UUIDs, typed roles, structured content. Everything we want
// (tokens, tool calls, file ops, todos) is right there in `tool_use`
// and `usage` fields. Codex rollouts are normalized to this same shape
// in prettyd before they reach the browser.

import { useMemo } from 'react';
import type { ClaudeSessionEvent } from '../types';
import type { SessionInfo } from '../types';
import type { SidebarChecklistItem } from '../types/sidebar';
import { previewToolInput } from '../lib/toolPreview';

export interface SessionSidebarState {
  parserName: string;
  parserIcon: string;
  // True when Claude is producing output / has been asked something
  // it hasn't replied to. Detection rules (in order of priority):
  //   1. If the most recent assistant event has stop_reason "end_turn",
  //      "stop_sequence", or "max_tokens" → turn is COMPLETE → idle.
  //   2. If the most recent user message has no assistant follow-up
  //      yet → working (Claude hasn't started replying).
  //   3. If the most recent assistant event has stop_reason "tool_use"
  //      → working (Claude called a tool and is waiting for its
  //      result before producing the next assistant event).
  //   4. Daemon byte-rate flag, as a fallback for the gap between
  //      Claude rendering output in the TUI and the matching
  //      assistant event landing in the JSONL.
  isWorking: boolean;
  // "7m 35s" while working, empty when idle.
  timer: string;
  // "1.9k" — tokens consumed in the current (in-progress or just-
  // completed) assistant turn.
  tokens: string;
  // "9m 50s" frozen from the last completed turn, shown while idle.
  finalElapsed: string;
  // Description of what Claude is doing right now — derived from the
  // latest in-flight tool_use call. Empty when idle.
  currentTask: string;
  // The latest TodoWrite checklist.
  checklist: SidebarChecklistItem[];
}

interface AnthropicContentBlock {
  type: string;
  text?: string;
  name?: string;
  input?: Record<string, unknown>;
}

interface AnthropicUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

function tool(s: SessionInfo['tool']): { name: string; icon: string } {
  if (s === 'claude-code') return { name: 'Claude Code', icon: '🟠' };
  if (s === 'codex') return { name: 'Codex', icon: '🟢' };
  return { name: 'Terminal', icon: '⬛' };
}

function formatTokens(n: number): string {
  if (n <= 0) return '';
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

function formatElapsed(ms: number): string {
  if (ms < 0) return '';
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return `${m}m ${sec}s`;
}

// Stop reasons that indicate a turn has fully completed. "tool_use" is
// NOT in this set — Claude emits an assistant event with that stop
// reason whenever it calls a tool, but the turn isn't done until the
// next assistant event with one of these.
const TERMINAL_STOP_REASONS = new Set([
  'end_turn',
  'stop_sequence',
  'max_tokens',
  'refusal'
]);

interface Args {
  session: SessionInfo | null;
  claudeEvents: ClaudeSessionEvent[];
  // Daemon-reported "this session is producing output right now" flag.
  // Filled in from SessionInfo.working. Augments the JSONL-based
  // awaiting state for the brief gap between Claude rendering a reply
  // and the matching assistant event landing in the JSONL file.
  daemonWorking: boolean;
}

export function useSessionSidebar({ session, claudeEvents, daemonWorking }: Args): SessionSidebarState {
  return useMemo((): SessionSidebarState => {
    const ident = tool(session?.tool ?? 'terminal');

    if (!session || (session.tool !== 'claude-code' && session.tool !== 'codex')) {
      // Terminal sessions: minimal sidebar. Working comes from daemon.
      return {
        parserName: ident.name,
        parserIcon: ident.icon,
        isWorking: daemonWorking,
        timer: '',
        tokens: '',
        finalElapsed: '',
        currentTask: '',
        checklist: []
      };
    }

    // Walk events oldest-first to accumulate sidebar state.
    let lastUserAt: number | null = null;
    // The most recent assistant event's stop_reason. Drives the working/
    // idle distinction: TERMINAL_STOP_REASONS = idle, "tool_use" = still
    // working, null = haven't seen an assistant event yet this turn.
    let latestStopReason: string | null = null;
    let latestAssistantAt: number | null = null;
    // Latest in-flight assistant turn's tokens (resets on next user
    // message). When a turn is mid-stream there are multiple assistant
    // events with growing token counts — we want the latest.
    let currentTurnTokens = 0;
    let lastCompletedTurnElapsed: number | null = null;
    let currentTask = '';
    // Latest TodoWrite payload — survives across turns until next write.
    let latestTodos: SidebarChecklistItem[] = [];

    for (const e of claudeEvents) {
      const ts = e.timestamp ? Date.parse(e.timestamp) : NaN;
      if (e.type === 'user') {
        // Skip tool_result entries — those are loop feedback from Claude,
        // not user-typed input. Real user messages have content as a
        // string OR a content array with a 'text' block.
        const content = e.message?.content;
        const isLoopFeedback =
          Array.isArray(content) &&
          content.every((b) => {
            const block = b as AnthropicContentBlock;
            return block.type === 'tool_result';
          });
        if (isLoopFeedback) continue;
        if (!Number.isNaN(ts)) lastUserAt = ts;
        // New user turn → reset in-progress turn state.
        currentTurnTokens = 0;
        currentTask = '';
        latestStopReason = null;
      } else if (e.type === 'assistant') {
        if (!Number.isNaN(ts)) latestAssistantAt = ts;
        // Accumulate tokens — assistant events stream multiple times per
        // turn, each one has the latest usage snapshot.
        const usage = e.message?.usage as AnthropicUsage | undefined;
        if (usage && typeof usage.output_tokens === 'number') {
          currentTurnTokens = usage.output_tokens;
        }
        // Track the latest stop_reason for the working/idle decision.
        if (typeof e.message?.stop_reason === 'string') {
          latestStopReason = e.message.stop_reason;
        }
        // Walk content blocks for tool_use (currentTask + todos).
        const content = e.message?.content;
        if (Array.isArray(content)) {
          for (const raw of content) {
            const block = raw as AnthropicContentBlock;
            if (block.type === 'tool_use' && block.name) {
              const preview = previewToolInput(block.name, block.input);
              currentTask = preview ? `${block.name}: ${preview}` : block.name;
              // TodoWrite: payload is the full new list, overwrite cache.
              if (block.name === 'TodoWrite' && Array.isArray(block.input?.['todos'])) {
                const todos = block.input!['todos'] as Array<{ content?: string; status?: string; activeForm?: string }>;
                latestTodos = todos.map((t) => {
                  const status: SidebarChecklistItem['status'] =
                    t.status === 'completed' ? 'done'
                    : t.status === 'in_progress' ? 'active'
                    : 'pending';
                  return { text: t.content ?? t.activeForm ?? '', status };
                });
              }
            }
          }
        }
        // If this is a terminal stop, freeze the turn elapsed.
        if (
          typeof e.message?.stop_reason === 'string'
          && TERMINAL_STOP_REASONS.has(e.message.stop_reason)
          && lastUserAt != null
          && !Number.isNaN(ts)
        ) {
          lastCompletedTurnElapsed = ts - lastUserAt;
        }
      }
    }

    // Working detection. The crucial fix vs the old "any assistant event
    // means done" check: Claude emits an assistant event with
    // stop_reason="tool_use" every time it calls a tool. The turn isn't
    // actually finished until we see a terminal stop reason. Without
    // this, the sidebar timer would freeze the second Claude called its
    // first tool (Read/Bash/etc) — even though Claude continued for
    // another N minutes processing those tool results.
    let isWorkingFromJsonl: boolean;
    if (lastUserAt == null) {
      isWorkingFromJsonl = false; // no user message → nothing to wait on
    } else if (latestStopReason == null) {
      isWorkingFromJsonl = true; // user message landed, no assistant yet
    } else if (TERMINAL_STOP_REASONS.has(latestStopReason)) {
      isWorkingFromJsonl = false; // turn complete
    } else {
      isWorkingFromJsonl = true; // intermediate (e.g. tool_use)
    }
    // Combine with daemon flag for the brief moment between PTY output
    // happening and the matching assistant event being written to JSONL.
    const isWorking = isWorkingFromJsonl || daemonWorking;

    // Timer: time since current turn started (if working).
    const timer = isWorking && lastUserAt != null
      ? formatElapsed(Date.now() - lastUserAt)
      : '';

    // finalElapsed: only show when NOT working.
    const finalElapsed = isWorking
      ? ''
      : (lastCompletedTurnElapsed != null
          ? formatElapsed(lastCompletedTurnElapsed)
          : (lastUserAt != null && latestAssistantAt != null && latestAssistantAt > lastUserAt
              ? formatElapsed(latestAssistantAt - lastUserAt)
              : ''));

    return {
      parserName: ident.name,
      parserIcon: ident.icon,
      isWorking,
      timer,
      tokens: formatTokens(currentTurnTokens),
      finalElapsed,
      currentTask: isWorking ? currentTask : '',
      checklist: latestTodos
    };
  }, [session, claudeEvents, daemonWorking]);
}
