// Turn Claude Code's persisted session events (sourced from the JSONL
// file at ~/.claude/projects/<encoded-cwd>/<id>.jsonl, streamed via
// WS) into the message shape RemoteView consumes.
//
// Event types Claude emits (from the live rail-me capture):
//   - 'user'                  user input OR Claude's tool_result loop feedback
//   - 'assistant'             Claude's reply: text, thinking, tool_use blocks
//   - 'system'                hook results, suggestions, errors
//   - 'attachment'            tool-registration metadata (MCP/skill announcements)
//   - 'file-history-snapshot' file-backup metadata for edits Claude makes
//   - 'last-prompt'           duplicate of the latest user input — skip
//   - 'permission-mode'       mode changes ('bypassPermissions' etc.)
//   - 'queue-operation'       user input typed while Claude was busy → queued
//
// Content blocks (inside `assistant`):
//   - 'text'      chat-visible
//   - 'thinking'  internal reasoning (encrypted in recent Claude) — surface
//                 a "💭 thought for X" badge but don't display raw text
//   - 'tool_use'  Claude called a tool → surface as a chip with name + input
//
// Content blocks (inside `user`):
//   - string content → plain user message
//   - 'text'         user typed (sometimes "[Request interrupted by user]")
//   - 'tool_result'  Claude's loop feedback (skip — not user content)
//   - 'image'        user pasted/attached an image

import type { ClaudeSessionEvent } from '../types';
import type { DispatchMessage, ToolCall } from '../hooks/useDispatch';
import { previewToolInput } from './toolPreview';

interface AnthropicContentBlock {
  type: string;
  text?: string;
  thinking?: string;
  // tool_use fields
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  // tool_result fields
  tool_use_id?: string;
  content?: unknown;
}

function isContentBlockArray(x: unknown): x is AnthropicContentBlock[] {
  return Array.isArray(x);
}

// Extract everything we care about from an assistant message's content
// array: visible text, tool calls, and whether thinking was present.
interface AssistantBreakdown {
  text: string;
  toolCalls: ToolCall[];
  hadThinking: boolean;
}
function breakdownAssistant(content: unknown): AssistantBreakdown {
  const result: AssistantBreakdown = { text: '', toolCalls: [], hadThinking: false };
  if (typeof content === 'string') {
    result.text = content;
    return result;
  }
  if (!isContentBlockArray(content)) return result;
  const textParts: string[] = [];
  for (const block of content) {
    if (block.type === 'text' && typeof block.text === 'string') {
      textParts.push(block.text);
    } else if (block.type === 'thinking') {
      result.hadThinking = true;
    } else if (block.type === 'tool_use' && block.id && block.name) {
      // inputFull is the prettyprinted JSON for the expanded view; the
      // preview is the one-line summary on the chip.
      let inputFull: string | undefined;
      if (block.input && typeof block.input === 'object') {
        try { inputFull = JSON.stringify(block.input, null, 2); } catch { /* skip */ }
      }
      result.toolCalls.push({
        id: block.id,
        name: block.name,
        inputPreview: previewToolInput(block.name, block.input),
        inputFull
      });
    }
  }
  result.text = textParts.join('\n\n').trim();
  return result;
}

// True if a user message's content is just tool_result blocks (not
// real user typing). Those events live in the JSONL because the API
// stream includes them, but they shouldn't render as user chat.
function isUserToolResultOnly(content: unknown): boolean {
  if (typeof content === 'string') return false;
  if (!isContentBlockArray(content)) return false;
  if (content.length === 0) return false;
  return content.every((b) => b.type === 'tool_result');
}

// Claude wraps a bunch of system-inserted "user" events around its
// own control flow:
//   <command-name>/compact</command-name>
//   <command-message>...</command-message>
//   <local-command-stdout>...</local-command-stdout>
//   <local-command-caveat>Caveat: The messages below were generated…
//   This session is being continued from a previous conversation that ran out of context…
//   <system-reminder>…</system-reminder>
//
// They're not user typing — they're system plumbing for /compact,
// --continue, --resume, etc. Rendering them as chat bubbles makes
// real user messages look lost in a wall of XML. Filter them out.
function isSystemUserPseudoMessage(text: string): boolean {
  const t = text.trimStart();
  if (t.startsWith('<command-name>')) return true;
  if (t.startsWith('<command-message>')) return true;
  if (t.startsWith('<command-args>')) return true;
  if (t.startsWith('<command-stdout>')) return true;
  if (t.startsWith('<local-command-stdout>')) return true;
  if (t.startsWith('<local-command-caveat>')) return true;
  if (t.startsWith('<system-reminder>')) return true;
  if (t.startsWith('This session is being continued from a previous conversation')) return true;
  if (t.startsWith('Caveat: The messages below were generated by the user while')) return true;
  return false;
}

// Extract user-typed text from a user message. Content can be a plain
// string (the typical case) OR an array containing text + image blocks.
function extractUserContent(content: unknown): { text: string; hasImage: boolean } {
  if (typeof content === 'string') return { text: content, hasImage: false };
  if (!isContentBlockArray(content)) return { text: '', hasImage: false };
  const parts: string[] = [];
  let hasImage = false;
  for (const block of content) {
    if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text);
    else if (block.type === 'image') hasImage = true;
  }
  return { text: parts.join('\n').trim(), hasImage };
}

function timestampMs(ts: unknown): number {
  if (typeof ts !== 'string') return Date.now();
  const n = Date.parse(ts);
  return Number.isFinite(n) ? n : Date.now();
}

// Extract tool_result content from a user event whose content is an
// array of tool_result blocks. Returns a map of tool_use_id → result
// string. Claude's tool_result content can be a string OR an array of
// content blocks (typically a text block); we flatten to a single
// string for display.
function indexToolResultsFromUser(ev: ClaudeSessionEvent): Map<string, string> {
  const map = new Map<string, string>();
  const content = ev.message?.content;
  if (!isContentBlockArray(content)) return map;
  for (const block of content) {
    if (block.type !== 'tool_result') continue;
    const id = block.tool_use_id;
    if (typeof id !== 'string') continue;
    let result = '';
    if (typeof block.content === 'string') {
      result = block.content;
    } else if (Array.isArray(block.content)) {
      const parts: string[] = [];
      for (const c of block.content as Array<Record<string, unknown>>) {
        if (c && c.type === 'text' && typeof c.text === 'string') parts.push(c.text);
      }
      result = parts.join('\n');
    }
    map.set(id, result);
  }
  return map;
}

const RESULT_PREVIEW_LEN = 120;

// Public entry. Walks the event stream in order and produces the
// RemoteView message list. Handles every Claude JSONL event type we've
// seen in the wild; unknown types pass through silently (forward-
// compatible with new Claude releases).
//
// Key shape decision: multi-step assistant turns (Claude calls 5
// tools then replies) arrive as a sequence of assistant events. We
// COLLAPSE consecutive tool-only assistant events into the next
// text-bearing one, so the chat reads as "user → (one assistant turn,
// optionally with N tool chips attached) → user". When the last
// assistant event in a turn is still tool-only (Claude is mid-turn,
// no reply yet), we emit a synthetic "in progress" assistant entry
// carrying the pending tool calls — the user can see what Claude is
// doing in real time. That entry's `id` is the last tool_use_id so
// React keeps it stable across re-renders.
export function eventsToMessages(events: ClaudeSessionEvent[]): DispatchMessage[] {
  // First pass: index every tool_result by tool_use_id. They live on
  // user events but logically belong to the assistant's tool_use that
  // requested them.
  const toolResults = new Map<string, string>();
  for (const ev of events) {
    if (ev.type === 'user' && ev.message?.role === 'user' && isUserToolResultOnly(ev.message?.content)) {
      for (const [id, result] of indexToolResultsFromUser(ev)) toolResults.set(id, result);
    }
  }

  const out: DispatchMessage[] = [];
  // Track pending tool calls accumulated across consecutive tool-only
  // assistant events. Drains into the next text-bearing assistant
  // event OR a synthetic "in progress" message at end-of-stream.
  let pendingTools: import('../hooks/useDispatch').ToolCall[] = [];
  let pendingHadThinking = false;
  // Track the earliest timestamp/uuid of the pending batch so when we
  // emit them attached to a later text event, the implicit "this turn
  // started" time is honest.
  let pendingFirstUuid: string | undefined;
  // queue-operation dedup (Claude sometimes enqueues the same text
  // twice; we drop replicas).
  const queuedContents = new Set<string>();

  const enrichToolCalls = (
    calls: import('../hooks/useDispatch').ToolCall[]
  ): import('../hooks/useDispatch').ToolCall[] => {
    return calls.map((t) => {
      const result = toolResults.get(t.id);
      if (!result) return t;
      const trimmed = result.length > RESULT_PREVIEW_LEN
        ? result.slice(0, RESULT_PREVIEW_LEN - 1) + '…'
        : result;
      return { ...t, resultPreview: trimmed.replace(/\s+/g, ' ').trim(), resultFull: result };
    });
  };

  for (const ev of events) {
    if (ev.type === 'user' && ev.message?.role === 'user') {
      const content = ev.message?.content;
      if (isUserToolResultOnly(content)) continue;
      const { text, hasImage } = extractUserContent(content);
      let body = text;
      if (!body && hasImage) body = '[image attached]';
      else if (!body) continue;
      // System-inserted control flow (compact, continue, system-reminders).
      // These are user-role events Claude writes for its own bookkeeping,
      // not human typing — skip them in the chat.
      if (isSystemUserPseudoMessage(body)) continue;

      const interrupted = body === '[Request interrupted by user]';
      queuedContents.delete(body.trim());

      out.push({
        id: ev.uuid ?? `user-evt-${out.length}`,
        role: 'user',
        content: body,
        status: 'sent',
        createdAt: timestampMs(ev.timestamp),
        confirmedAt: timestampMs(ev.timestamp),
        blockId: ev.uuid,
        interrupted: interrupted || undefined
      });
      continue;
    }

    if (ev.type === 'assistant' && ev.message?.role === 'assistant') {
      const breakdown = breakdownAssistant(ev.message?.content);
      // Tool-only assistant event (Claude called a tool, no text reply
      // yet) — buffer the tool calls and continue. The next
      // text-bearing assistant event will absorb them.
      if (!breakdown.text) {
        if (breakdown.toolCalls.length > 0) {
          pendingTools.push(...breakdown.toolCalls);
          if (!pendingFirstUuid) pendingFirstUuid = ev.uuid;
        }
        if (breakdown.hadThinking) pendingHadThinking = true;
        continue;
      }
      // Text-bearing event — emit a real message that absorbs every
      // pending tool from earlier in this turn.
      const collected = enrichToolCalls([...pendingTools, ...breakdown.toolCalls]);
      const hadThinkingAny = pendingHadThinking || breakdown.hadThinking;
      pendingTools = [];
      pendingHadThinking = false;
      pendingFirstUuid = undefined;
      out.push({
        id: ev.uuid ?? `asst-evt-${out.length}`,
        role: 'assistant',
        content: breakdown.text,
        status: 'sent',
        createdAt: timestampMs(ev.timestamp),
        blockId: ev.uuid,
        toolCalls: collected.length > 0 ? collected : undefined,
        hadThinking: hadThinkingAny || undefined
      });
      continue;
    }

    if (ev.type === 'queue-operation') {
      const op = (ev as Record<string, unknown>).operation;
      const text = (ev as Record<string, unknown>).content;
      if (op !== 'enqueue' || typeof text !== 'string' || !text.trim()) continue;
      const trimmed = text.trim();
      if (queuedContents.has(trimmed)) continue;
      queuedContents.add(trimmed);
      out.push({
        id: `queue-${out.length}-${trimmed.slice(-12)}`,
        role: 'user',
        content: text,
        status: 'sent',
        createdAt: timestampMs(ev.timestamp),
        queued: true
      });
      continue;
    }
    // permission-mode / system / attachment / file-history-snapshot /
    // last-prompt are bookkeeping; skipped.
  }

  // Drain: if Claude is mid-turn (tools called, no text yet), emit a
  // synthetic "in progress" assistant message carrying the pending
  // tool calls. Stable id from the first tool's uuid so React doesn't
  // re-key on every tick.
  if (pendingTools.length > 0) {
    const collected = enrichToolCalls(pendingTools);
    out.push({
      id: pendingFirstUuid ?? `asst-pending-${out.length}`,
      role: 'assistant',
      content: '',
      status: 'sent',
      createdAt: Date.now(),
      blockId: pendingFirstUuid,
      toolCalls: collected.length > 0 ? collected : undefined,
      hadThinking: pendingHadThinking || undefined
    });
  }

  // Final pass: drop queued entries already superseded by the real
  // user_input event further down the list.
  return out.filter((m, i) => {
    if (!m.queued) return true;
    for (let j = i + 1; j < out.length; j++) {
      const other = out[j];
      if (other && other.role === 'user' && !other.queued && other.content.trim() === m.content.trim()) {
        return false;
      }
    }
    return true;
  });
}
