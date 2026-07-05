import type { JsonValue } from './codexProto/serde_json/JsonValue.js';
import type { ServerNotification } from './codexProto/ServerNotification.js';
import type { ThreadItem } from './codexProto/v2/ThreadItem.js';
import type { ThreadTokenUsage } from './codexProto/v2/ThreadTokenUsage.js';
import type { TokenUsageBreakdown } from './codexProto/v2/TokenUsageBreakdown.js';
import type { UserInput } from './codexProto/v2/UserInput.js';
import type { ClaudeSessionEvent } from './sessionFileWatcher.js';

export interface CodexAppServerNormalizeContext {
  sourceId?: string;
  sequence?: number;
}

export interface CodexAppServerNormalization {
  events: ClaudeSessionEvent[];
  working: boolean | null;
}

interface ClaudeTextBlock {
  type: 'text';
  text: string;
}

interface ClaudeToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
}

interface ClaudeToolResultBlock {
  type: 'tool_result';
  tool_use_id: string;
  content: string;
}

interface AppServerUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  reasoning_output_tokens: number;
  total_tokens: number;
  total: TokenUsageBreakdown;
  last: TokenUsageBreakdown;
  model_context_window: number | null;
}

type ItemLifecycle = 'started' | 'completed';

export class CodexAppServerNormalizer {
  private sequence = 0;
  private readonly emittedUuids = new Set<string>();

  constructor(private readonly context: Omit<CodexAppServerNormalizeContext, 'sequence'> = {}) {}

  normalize(notification: ServerNotification): CodexAppServerNormalization {
    const normalized = normalizeCodexAppServerNotification(notification, {
      ...this.context,
      sequence: this.sequence
    });
    this.sequence += 1;

    const events = normalized.events.filter((event) => {
      if (!event.uuid) return true;
      if (this.emittedUuids.has(event.uuid)) return false;
      this.emittedUuids.add(event.uuid);
      return true;
    });
    return { events, working: normalized.working };
  }
}

export function normalizeCodexAppServerNotification(
  notification: ServerNotification,
  ctx: CodexAppServerNormalizeContext = {}
): CodexAppServerNormalization {
  switch (notification.method) {
    case 'turn/started':
      return { events: [], working: true };
    case 'turn/completed':
      return {
        events: [turnCompletedEvent(notification.params.threadId, notification.params.turn, ctx)],
        working: false
      };
    case 'item/started':
      return {
        events: normalizeThreadItem(
          notification.params.item,
          notification.params.threadId,
          notification.params.turnId,
          timestampFromMs(notification.params.startedAtMs),
          'started',
          ctx
        ),
        working: true
      };
    case 'item/completed':
      return {
        events: normalizeThreadItem(
          notification.params.item,
          notification.params.threadId,
          notification.params.turnId,
          timestampFromMs(notification.params.completedAtMs),
          'completed',
          ctx
        ),
        working: null
      };
    case 'item/agentMessage/delta':
      return { events: [], working: true };
    case 'thread/tokenUsage/updated':
      return {
        events: [tokenUsageEvent(
          notification.params.threadId,
          notification.params.turnId,
          notification.params.tokenUsage,
          ctx
        )],
        working: null
      };
    case 'error':
      return { events: [], working: false };
    default:
      return { events: [], working: null };
  }
}

function normalizeThreadItem(
  item: ThreadItem,
  threadId: string,
  turnId: string,
  timestamp: string,
  lifecycle: ItemLifecycle,
  ctx: CodexAppServerNormalizeContext
): ClaudeSessionEvent[] {
  switch (item.type) {
    case 'userMessage':
      return normalizeUserMessage(item, threadId, turnId, timestamp, ctx);
    case 'agentMessage':
      if (lifecycle !== 'completed' || !item.text.trim()) return [];
      return [assistantTextEvent(threadId, turnId, item.id, item.text, timestamp, ctx)];
    case 'commandExecution':
      return normalizeCommandExecution(item, threadId, turnId, timestamp, lifecycle, ctx);
    case 'mcpToolCall':
      return normalizeMcpToolCall(item, threadId, turnId, timestamp, lifecycle, ctx);
    case 'dynamicToolCall':
      return normalizeDynamicToolCall(item, threadId, turnId, timestamp, lifecycle, ctx);
    case 'fileChange':
      return normalizeFileChange(item, threadId, turnId, timestamp, lifecycle, ctx);
    case 'webSearch':
      return [toolUseEvent(threadId, turnId, item.id, 'web_search', { query: item.query, action: item.action }, timestamp, ctx)];
    default:
      return [];
  }
}

function normalizeUserMessage(
  item: Extract<ThreadItem, { type: 'userMessage' }>,
  threadId: string,
  turnId: string,
  timestamp: string,
  ctx: CodexAppServerNormalizeContext
): ClaudeSessionEvent[] {
  const content = item.content.map(userInputToClaudeBlock).filter((block): block is ClaudeTextBlock | Record<string, unknown> => block !== null);
  if (content.length === 0) return [];
  return [{
    type: 'user',
    uuid: eventUuid(ctx, threadId, turnId, item.id),
    timestamp,
    sessionId: threadId,
    message: {
      role: 'user',
      content
    }
  }];
}

function normalizeCommandExecution(
  item: Extract<ThreadItem, { type: 'commandExecution' }>,
  threadId: string,
  turnId: string,
  timestamp: string,
  lifecycle: ItemLifecycle,
  ctx: CodexAppServerNormalizeContext
): ClaudeSessionEvent[] {
  const events: ClaudeSessionEvent[] = [
    toolUseEvent(threadId, turnId, item.id, 'command', {
      command: item.command,
      cwd: item.cwd,
      source: item.source,
      actions: item.commandActions
    }, timestamp, ctx)
  ];

  if (lifecycle === 'completed') {
    const content = item.aggregatedOutput ?? stableStringify({
      status: item.status,
      exitCode: item.exitCode,
      durationMs: item.durationMs
    });
    events.push(toolResultEvent(threadId, turnId, item.id, content, timestamp, ctx));
  }
  return events;
}

function normalizeMcpToolCall(
  item: Extract<ThreadItem, { type: 'mcpToolCall' }>,
  threadId: string,
  turnId: string,
  timestamp: string,
  lifecycle: ItemLifecycle,
  ctx: CodexAppServerNormalizeContext
): ClaudeSessionEvent[] {
  const events: ClaudeSessionEvent[] = [
    toolUseEvent(threadId, turnId, item.id, `${item.server}.${item.tool}`, {
      arguments: item.arguments,
      appContext: item.appContext,
      pluginId: item.pluginId
    }, timestamp, ctx)
  ];

  if (lifecycle === 'completed') {
    const content = item.error
      ? item.error.message
      : item.result
        ? mcpResultToString(item.result.content, item.result.structuredContent)
        : stableStringify({ status: item.status, durationMs: item.durationMs });
    events.push(toolResultEvent(threadId, turnId, item.id, content, timestamp, ctx));
  }
  return events;
}

function normalizeDynamicToolCall(
  item: Extract<ThreadItem, { type: 'dynamicToolCall' }>,
  threadId: string,
  turnId: string,
  timestamp: string,
  lifecycle: ItemLifecycle,
  ctx: CodexAppServerNormalizeContext
): ClaudeSessionEvent[] {
  const name = item.namespace ? `${item.namespace}.${item.tool}` : item.tool;
  const events: ClaudeSessionEvent[] = [
    toolUseEvent(threadId, turnId, item.id, name, {
      arguments: item.arguments
    }, timestamp, ctx)
  ];

  if (lifecycle === 'completed') {
    const content = item.contentItems
      ? stableStringify(item.contentItems)
      : stableStringify({ status: item.status, success: item.success });
    events.push(toolResultEvent(threadId, turnId, item.id, content, timestamp, ctx));
  }
  return events;
}

function normalizeFileChange(
  item: Extract<ThreadItem, { type: 'fileChange' }>,
  threadId: string,
  turnId: string,
  timestamp: string,
  lifecycle: ItemLifecycle,
  ctx: CodexAppServerNormalizeContext
): ClaudeSessionEvent[] {
  const events: ClaudeSessionEvent[] = [
    toolUseEvent(threadId, turnId, item.id, 'file_change', {
      status: item.status,
      changes: item.changes
    }, timestamp, ctx)
  ];
  if (lifecycle === 'completed') {
    events.push(toolResultEvent(threadId, turnId, item.id, stableStringify({
      status: item.status,
      changes: item.changes
    }), timestamp, ctx));
  }
  return events;
}

function assistantTextEvent(
  threadId: string,
  turnId: string,
  itemId: string,
  text: string,
  timestamp: string,
  ctx: CodexAppServerNormalizeContext
): ClaudeSessionEvent {
  return {
    type: 'assistant',
    uuid: eventUuid(ctx, threadId, turnId, itemId),
    timestamp,
    sessionId: threadId,
    message: {
      role: 'assistant',
      content: [{ type: 'text', text } satisfies ClaudeTextBlock]
    }
  };
}

function toolUseEvent(
  threadId: string,
  turnId: string,
  itemId: string,
  name: string,
  input: Record<string, unknown>,
  timestamp: string,
  ctx: CodexAppServerNormalizeContext
): ClaudeSessionEvent {
  return {
    type: 'assistant',
    uuid: eventUuid(ctx, threadId, turnId, `${itemId}:tool_use`),
    timestamp,
    sessionId: threadId,
    message: {
      role: 'assistant',
      content: [{
        type: 'tool_use',
        id: itemId,
        name,
        input
      } satisfies ClaudeToolUseBlock]
    }
  };
}

function toolResultEvent(
  threadId: string,
  turnId: string,
  itemId: string,
  content: string,
  timestamp: string,
  ctx: CodexAppServerNormalizeContext
): ClaudeSessionEvent {
  return {
    type: 'user',
    uuid: eventUuid(ctx, threadId, turnId, `${itemId}:tool_result`),
    timestamp,
    sessionId: threadId,
    message: {
      role: 'user',
      content: [{
        type: 'tool_result',
        tool_use_id: itemId,
        content
      } satisfies ClaudeToolResultBlock]
    }
  };
}

function tokenUsageEvent(
  threadId: string,
  turnId: string,
  tokenUsage: ThreadTokenUsage,
  ctx: CodexAppServerNormalizeContext
): ClaudeSessionEvent {
  const last = tokenUsage.last;
  const usage: AppServerUsage = {
    input_tokens: last.inputTokens,
    output_tokens: last.outputTokens,
    cache_read_input_tokens: last.cachedInputTokens,
    reasoning_output_tokens: last.reasoningOutputTokens,
    total_tokens: last.totalTokens,
    total: tokenUsage.total,
    last,
    model_context_window: tokenUsage.modelContextWindow
  };
  return {
    type: 'assistant',
    uuid: eventUuid(ctx, threadId, turnId, `usage:${last.totalTokens}:${ctx.sequence ?? 0}`),
    timestamp: timestampFromMs(Date.now()),
    sessionId: threadId,
    message: {
      role: 'assistant',
      content: [],
      usage
    }
  };
}

function turnCompletedEvent(
  threadId: string,
  turn: { id: string; completedAt: number | null; status: string; durationMs: number | null },
  ctx: CodexAppServerNormalizeContext
): ClaudeSessionEvent {
  return {
    type: 'assistant',
    uuid: eventUuid(ctx, threadId, turn.id, 'turn_completed'),
    timestamp: turn.completedAt === null ? timestampFromMs(Date.now()) : timestampFromMs(turn.completedAt * 1000),
    sessionId: threadId,
    codexTurnStatus: turn.status,
    durationMs: turn.durationMs,
    message: {
      role: 'assistant',
      content: [],
      stop_reason: 'end_turn'
    }
  };
}

function userInputToClaudeBlock(input: UserInput): ClaudeTextBlock | Record<string, unknown> | null {
  switch (input.type) {
    case 'text':
      return input.text ? { type: 'text', text: input.text } : null;
    case 'image':
      return { type: 'image', url: input.url, detail: input.detail };
    case 'localImage':
      return { type: 'image', path: input.path, detail: input.detail };
    case 'skill':
      return { type: 'text', text: `@${input.name}` };
    case 'mention':
      return { type: 'text', text: `@${input.name}` };
  }
}

function mcpResultToString(content: JsonValue[], structuredContent: JsonValue | null): string {
  if (structuredContent !== null) return jsonValueToString(structuredContent);
  return content.map(jsonValueToString).filter((part) => part.length > 0).join('\n');
}

function jsonValueToString(value: JsonValue): string {
  if (typeof value === 'string') return value;
  return stableStringify(value);
}

function stableStringify(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function timestampFromMs(ms: number): string {
  return new Date(ms).toISOString();
}

function eventUuid(
  ctx: CodexAppServerNormalizeContext,
  threadId: string,
  turnId: string,
  suffix: string
): string {
  return `${ctx.sourceId ?? 'codex-appserver'}:${threadId}:${turnId}:${suffix}`;
}
