// Parses Claude Code terminal output (captured from tmux) into typed blocks.
//
// The terminal output is line-oriented. We walk top-to-bottom, classify each
// line by its leading marker, and group continuation lines under whichever
// block "owns" them. Stable IDs (per type / per content) let React keep DOM
// nodes mounted across polls so the live thinking indicator and streaming
// blocks don't flicker.
//
// Each line is stored as a {raw, clean} pair so we can pattern-match on the
// stripped (no ANSI) form while preserving the raw form for rendering — that
// way Claude Code's color classifications (file paths blue, errors red, etc.)
// survive into the UI even though the parser still sees marker chars cleanly.

import { stripAnsi } from './ansi';
export { stripAnsi };

export type BlockType =
  | 'banner'
  | 'session_divider'
  | 'permissions_badge'
  | 'system_notice'
  | 'user_input'
  | 'tool_chip'
  | 'tool_use'
  | 'command'
  | 'claude_message'
  | 'thinking_active'
  | 'thinking'
  | 'search_status'
  | 'file_read'
  | 'file_write'
  | 'error'
  | 'terminal_passthrough'
  | 'unknown';

export interface UserResponse {
  type: 'error' | 'text';
  content: string;
}

export interface Block {
  id: string;
  type: BlockType;
  content: string;
  summary: string;
  streaming?: boolean;
  metadata: {
    // Banner
    version?: string;
    model?: string;
    cwd?: string;
    // Tool use
    toolName?: string;
    toolArgs?: string;
    doneSummary?: string;
    // Search status
    query?: string;
    detail?: string;
    // Thinking active
    timer?: string;
    tokens?: string;
    // User input
    responses?: UserResponse[];
    isSlashCommand?: boolean;
    // Bash
    command?: string;
    output?: string;
    // File
    filename?: string;
    fileType?: string;
    diff?: { added: string[]; removed: string[] };
    // Common
    url?: string;
    tool?: string;
  };
}

// ────────────────────────────────────────────────────────────────────────────
// Helpers

interface Line {
  raw: string;   // original tmux output line, may contain ANSI escape codes
  clean: string; // ANSI-stripped, used for pattern matching only
}

function toLines(raw: string): Line[] {
  return raw.split('\n').map((r) => ({ raw: r, clean: stripAnsi(r) }));
}

function stripExpandHint(s: string): string {
  return s.replace(/\s*\(ctrl\+o to expand\)\s*$/i, '');
}

// Tiny deterministic string hash → short hex. Used for stable React keys so
// the same logical block keeps the same id across re-parses.
function shortHash(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  }
  return (h >>> 0).toString(36);
}

// ────────────────────────────────────────────────────────────────────────────
// Line classifiers

function isHorizontalRule(trimmed: string): boolean {
  return /^─{3,}$/.test(trimmed);
}

function isShellPrompt(trimmed: string): boolean {
  return /^\(.*?\)\s+\S+@\S+.*[%$]\s/.test(trimmed) || / [%$] claude(\s|$)/.test(trimmed);
}

function isHelpHint(trimmed: string): boolean {
  return (
    /^\?\s+for shortcuts$/i.test(trimmed) ||
    /Esc to cancel/i.test(trimmed) ||
    /shift\+tab to cycle/i.test(trimmed) ||
    /ctrl\+e to explain/i.test(trimmed)
  );
}

function isResumeLine(trimmed: string): boolean {
  return (
    /^Resume this session with/i.test(trimmed) ||
    /^claude --resume\b/.test(trimmed)
  );
}

function isTipLine(trimmed: string): boolean {
  return /^⎿\s*Tip:/i.test(trimmed);
}

function isPermissionOption23(trimmed: string): boolean {
  return /^\d+\.\s/.test(trimmed) && !/^1\./.test(trimmed);
}

function isBannerLine(clean: string): boolean {
  return (
    clean.includes('▐▛') ||
    clean.includes('▝▜') ||
    clean.includes('▘▘') ||
    /Claude Code v\d/.test(clean)
  );
}

function isToolChip(clean: string): boolean {
  if (!/^\s+/.test(clean)) return false;
  const t = clean.trim();
  return /^(Searched for|Listed|Read|Found)\s+\d+/i.test(t);
}

// ────────────────────────────────────────────────────────────────────────────
// Block factories

let nextSeq = 0;
function reset(): void {
  nextSeq = 0;
}
function seq(): number {
  return nextSeq++;
}

function makeBanner(version: string, model: string, cwd: string): Block {
  return {
    id: `banner-${seq()}`,
    type: 'banner',
    content: '',
    summary: version,
    metadata: { version, model, cwd }
  };
}

function makeSessionDivider(): Block {
  return {
    id: `divider-${seq()}`,
    type: 'session_divider',
    content: '',
    summary: 'Session ended',
    metadata: {}
  };
}

function makePermissionsBadge(): Block {
  return {
    id: 'permissions-badge',
    type: 'permissions_badge',
    content: '',
    summary: 'Permissions bypassed',
    metadata: {}
  };
}

function makeSystemNotice(text: string): Block {
  // text is the cleaned form — system notices are short metadata, ANSI not
  // useful here.
  const clean = text.replace(/^✻\s*/, '').trim();
  return {
    id: `notice-${seq()}-${shortHash(clean.slice(0, 30))}`,
    type: 'system_notice',
    content: clean,
    summary: clean,
    metadata: {}
  };
}

function makeToolChip(text: string): Block {
  const clean = stripExpandHint(text.trim());
  return {
    id: `chip-${seq()}-${shortHash(clean)}`,
    type: 'tool_chip',
    content: clean,
    summary: clean,
    metadata: {}
  };
}

// ────────────────────────────────────────────────────────────────────────────
// Sub-parsers

interface ParseResult {
  block: Block;
  nextIndex: number;
}

function isBoundary(clean: string): boolean {
  const t = clean.trim();
  if (!t) return false;
  // Marker must be followed by whitespace (or be the entire line) — guards
  // against quoted text inside comments / prompts that happens to start with
  // a marker character.
  if (/^⏺\s+/.test(t)) return true;
  if (/^❯\s/.test(t) || t === '❯') return true;
  if (/^✻\s+\S/.test(t)) return true;
  if (/^✳\s+\w+…/.test(t)) return true;
  if (/^●\s/.test(t)) return true;
  if (t.startsWith('⏵⏵')) return true;
  if (isResumeLine(t)) return true;
  // NOTE: horizontal rules (─{3,}) are NOT boundaries. Claude often writes
  // section-separator rules INSIDE a message body (e.g. between numbered
  // gap items in a recap), and treating them as boundaries would truncate
  // the message at the first separator. The trailing chrome rule that
  // tmux renders below the message area is harmless inside the message —
  // collectContinuation will keep walking and stop at the bare ❯ prompt
  // that comes right after.
  if (isBannerLine(t)) return true;
  return false;
}

// Collect continuation lines under the current block. Stops at the first
// boundary marker. Trailing blank lines are dropped. Returns Line[] so the
// caller still has both raw and clean forms for each gathered line.
function collectContinuation(lines: Line[], start: number): { content: Line[]; next: number } {
  const out: Line[] = [];
  let i = start;
  while (i < lines.length) {
    const line = lines[i];
    if (isBoundary(line.clean)) break;
    out.push(line);
    i++;
  }
  while (out.length && !out[out.length - 1].clean.trim()) out.pop();
  return { content: out, next: i };
}

function parseBanner(lines: Line[], start: number): ParseResult {
  let version = '';
  let model = '';
  let cwd = '';
  let i = start;
  while (i < lines.length) {
    const { clean } = lines[i];
    if (!isBannerLine(clean) && !/^\s{2,}[~/]/.test(clean)) {
      if (!cwd && /^\s+[~/]/.test(clean)) {
        cwd = clean.trim();
        i++;
        continue;
      }
      break;
    }
    const vMatch = clean.match(/Claude Code v([\w.]+)/);
    if (vMatch) version = vMatch[1];
    const modelMatch = clean.match(/(Opus|Sonnet|Haiku)[^·]*/);
    if (modelMatch && !model) model = modelMatch[0].trim();
    // cwd line: indented path. Allow both absolute (/...) and tilde (~/...)
    // forms — Claude Code shows the tilde form when running from $HOME.
    const cwdMatch = clean.match(/\s(~\/?[^\s]*|\/[^\s]+)\s*$/);
    if (cwdMatch && !cwd) cwd = cwdMatch[1];
    i++;
  }
  return { block: makeBanner(version, model, cwd), nextIndex: i };
}

function parseUserInput(text: string, lines: Line[], start: number): ParseResult {
  // ⎿ responses are short status text (errors, slash command output) — store
  // the cleaned form. ANSI here is rare and not useful.
  const responses: UserResponse[] = [];
  let i = start;
  while (i < lines.length && !lines[i].clean.trim()) i++;
  if (i < lines.length) {
    const t = lines[i].clean.trim();
    if (t.startsWith('⎿')) {
      const responseLines: string[] = [t.replace(/^⎿\s*/, '')];
      i++;
      while (i < lines.length) {
        const next = lines[i];
        const nt = next.clean.trim();
        if (!nt) break;
        if (isBoundary(next.clean)) break;
        if (next.clean.startsWith('   ') || next.clean.startsWith('  ')) {
          responseLines.push(nt);
          i++;
        } else {
          break;
        }
      }
      const joined = responseLines.join(' ').trim();
      if (/^API Error/i.test(joined) || /"type"\s*:\s*"error"/.test(joined)) {
        let message = joined;
        const msgMatch = joined.match(/"message"\s*:\s*"([^"]+)"/);
        const codeMatch = joined.match(/API Error:\s*(\d+)/);
        if (msgMatch) {
          const code = codeMatch ? `${codeMatch[1]} ` : '';
          message = `${code}${msgMatch[1]}`.trim();
        }
        responses.push({ type: 'error', content: message });
      } else {
        responses.push({ type: 'text', content: joined });
      }
    }
  }

  const isSlash = text.startsWith('/');
  const id = `user-${seq()}-${shortHash(text.slice(0, 40))}`;
  return {
    block: {
      id,
      type: 'user_input',
      content: text,
      summary: text,
      metadata: { responses, isSlashCommand: isSlash }
    },
    nextIndex: i
  };
}

function parseSearchStatus(stripped: string, lines: Line[], start: number): ParseResult {
  // detail comes from a ⎿ line — we want to preserve ANSI codes there so the
  // file paths inside the search query render in color.
  const query = stripExpandHint(stripped).replace(/…\s*$/, '').trim();
  const { content, next } = collectContinuation(lines, start);
  let detail = '';
  for (const l of content) {
    const t = l.clean.trim();
    if (t.startsWith('⎿')) {
      // Strip the ⎿ marker from the raw form. The marker itself is rarely
      // ANSI-wrapped, so a literal-string replace works.
      detail = stripExpandHint(l.raw.replace(/^\s*⎿\s*/, ''));
      break;
    }
  }
  const idHash = shortHash(query.slice(0, 40));
  return {
    block: {
      id: `search-${idHash}`,
      type: 'search_status',
      content: detail,
      summary: query,
      streaming: true,
      metadata: { query, detail }
    },
    nextIndex: next
  };
}

function parseToolUse(
  toolName: string,
  toolArgs: string,
  lines: Line[],
  start: number
): ParseResult {
  const { content, next } = collectContinuation(lines, start);
  let doneSummary = '';
  let streaming = false;
  const bodyLines: string[] = []; // raw, ANSI-preserving
  for (const l of content) {
    const cleanT = stripExpandHint(l.clean.trim());
    if (!cleanT) continue;
    if (cleanT.startsWith('⎿')) {
      const innerClean = cleanT.replace(/^⎿\s*/, '');
      if (/^Done\b/i.test(innerClean)) {
        doneSummary = innerClean;
      } else if (/Running…?$/i.test(innerClean)) {
        streaming = true;
      } else {
        // Preserve ANSI in raw body — strip the marker via a regex that allows
        // optional ANSI escapes between the leading whitespace and ⎿.
        const rawInner = stripExpandHint(
          l.raw.replace(/^\s*(?:\x1b\[[0-9;]*m)*⎿\s*/, '').trimEnd()
        );
        bodyLines.push(rawInner);
      }
    } else {
      bodyLines.push(stripExpandHint(l.raw.trimEnd()));
    }
  }
  const isBash = /^bash$/i.test(toolName);
  const id = isBash
    ? `bash-${shortHash(toolArgs.slice(0, 60))}`
    : `tool-${shortHash(toolName + ':' + toolArgs.slice(0, 40))}`;
  const joinedBody = bodyLines.join('\n');
  return {
    block: {
      id,
      type: isBash ? 'command' : 'tool_use',
      content: joinedBody,
      summary: toolArgs,
      streaming,
      metadata: {
        toolName,
        toolArgs,
        doneSummary,
        tool: toolName,
        command: isBash ? toolArgs : undefined,
        output: isBash ? joinedBody : undefined
      }
    },
    nextIndex: next
  };
}

function parseClaudeMessage(firstLine: string, lines: Line[], start: number): ParseResult {
  // firstLine is the cleaned (no ANSI) text after the ⏺ marker. Continuation
  // lines preserve their raw ANSI form so colors come through in the body.
  const { content, next } = collectContinuation(lines, start);
  const body = content.map((l) => l.raw.replace(/^ {2}/, '').trimEnd());
  const all = [firstLine, ...body].join('\n').replace(/\n+$/, '');
  const idHash = shortHash(firstLine.slice(0, 40));
  return {
    block: {
      id: `claude-${idHash}`,
      type: 'claude_message',
      content: all,
      summary: firstLine.slice(0, 80),
      metadata: {}
    },
    nextIndex: next
  };
}

function parseThinkingActive(lines: Line[], start: number): ParseResult {
  const line = lines[start].clean.trim().replace(/^✳\s*/, '');
  let timer = '';
  let tokens = '';
  const timerMatch = line.match(/\((\d+m\s*\d+s|\d+s|\d+m)\b/);
  if (timerMatch) timer = timerMatch[1];
  const tokenMatch = line.match(/↓\s*([\d.]+\s*\w*)\s*tokens/i);
  if (tokenMatch) tokens = tokenMatch[1];
  let next = start + 1;
  while (next < lines.length) {
    const t = lines[next].clean.trim();
    if (!t) { next++; continue; }
    if (isTipLine(t)) { next++; continue; }
    break;
  }
  return {
    block: {
      id: 'thinking-active',
      type: 'thinking_active',
      content: line,
      summary: 'Thinking…',
      streaming: true,
      metadata: { timer, tokens }
    },
    nextIndex: next
  };
}

// ────────────────────────────────────────────────────────────────────────────
// Main parse loop

export function parseClaudeOutput(raw: string): Block[] {
  reset();
  const lines = toLines(raw);
  const blocks: Block[] = [];
  let sawAnyBlock = false;
  let permissionsBypassed = false;

  let i = 0;
  while (i < lines.length) {
    const { clean } = lines[i];
    const trimmed = clean.trim();

    if (!trimmed) { i++; continue; }

    // Permissions bypass marker — must run before isHelpHint because the line
    // contains "shift+tab to cycle" and would otherwise be filtered.
    if (trimmed.startsWith('⏵⏵')) {
      permissionsBypassed = true;
      i++;
      continue;
    }

    if (isShellPrompt(trimmed)) { i++; continue; }
    if (isHorizontalRule(trimmed)) { i++; continue; }
    if (isHelpHint(trimmed)) { i++; continue; }
    if (isPermissionOption23(trimmed)) { i++; continue; }
    if (isTipLine(trimmed)) { i++; continue; }
    if (/^Do you want to proceed\??$/i.test(trimmed)) { i++; continue; }

    if (isResumeLine(trimmed)) {
      if (sawAnyBlock) blocks.push(makeSessionDivider());
      i++;
      while (i < lines.length && !isBannerLine(lines[i].clean)) i++;
      continue;
    }

    if (isBannerLine(clean)) {
      if (sawAnyBlock) {
        const lastBlock = blocks[blocks.length - 1];
        if (lastBlock && lastBlock.type !== 'session_divider') {
          blocks.push(makeSessionDivider());
        }
      }
      const r = parseBanner(lines, i);
      blocks.push(r.block);
      sawAnyBlock = true;
      i = r.nextIndex;
      if (permissionsBypassed) {
        blocks.push(makePermissionsBadge());
      }
      continue;
    }

    if (trimmed.startsWith('●') && /how is claude/i.test(trimmed)) {
      i++;
      if (i < lines.length && /^\s*1\s*:/.test(lines[i].clean)) i++;
      continue;
    }

    // Strict matchers — the marker char must be followed by a space and then
    // text that looks like a real Claude Code marker. Without these guards,
    // any string in a comment or quoted prompt that happens to start with the
    // marker char gets parsed as a real block (false positives).
    if (/^✻\s+\S/.test(trimmed)) {
      blocks.push(makeSystemNotice(trimmed));
      sawAnyBlock = true;
      i++;
      continue;
    }

    // Real thinking indicator: "✳ Bunning… (7m 35s · ↓ 1.9k tokens · …)"
    // Require: ✳ + space + word + ellipsis + paren.
    if (/^✳\s+\w+…\s*\(/.test(trimmed)) {
      const r = parseThinkingActive(lines, i);
      blocks.push(r.block);
      sawAnyBlock = true;
      i = r.nextIndex;
      continue;
    }

    if (/^❯\s/.test(trimmed) || trimmed === '❯') {
      let userText = trimmed.replace(/^❯\s*/, '').trim();
      userText = userText.replace(/%$/, '').trim();
      if (!userText) { i++; continue; }

      // Collect indented wrap-continuation lines. Claude Code's Ink
      // renderer emits literal newlines for soft-wrapped input — tmux's
      // `-J` flag can't undo that because tmux didn't insert the wraps,
      // Ink did. Each continuation line is indented by 2 spaces (the
      // visual alignment that follows `❯ `). Strip the leading 2 spaces
      // (preserving any deeper indent the user typed) and append.
      let userEnd = i + 1;
      while (userEnd < lines.length) {
        const ln = lines[userEnd];
        const nt = ln.clean.trim();
        if (!nt) break;                   // blank line ends the user input
        if (isBoundary(ln.clean)) break;   // any marker ends the user input
        if (!/^\s/.test(ln.clean)) break;  // non-indented = end of input
        const stripped = ln.clean.replace(/^ {1,2}/, '').trimEnd();
        userText += '\n' + stripped;
        userEnd++;
      }

      const r = parseUserInput(userText, lines, userEnd);
      blocks.push(r.block);
      sawAnyBlock = true;
      i = r.nextIndex;
      continue;
    }

    if (/^⏺\s+/.test(trimmed)) {
      const stripped = stripExpandHint(trimmed.replace(/^⏺\s*/, ''));

      if (/^(Searching for|Reading)\b/i.test(stripped)) {
        const r = parseSearchStatus(stripped, lines, i + 1);
        blocks.push(r.block);
        sawAnyBlock = true;
        i = r.nextIndex;
        continue;
      }

      if (/^Thinking\b/i.test(stripped)) {
        const { content, next } = collectContinuation(lines, i + 1);
        const all = [stripped, ...content.map((l) => l.raw.replace(/^ {2}/, ''))]
          .join('\n')
          .trim();
        blocks.push({
          id: `thinking-${shortHash(all.slice(0, 40))}`,
          type: 'thinking',
          content: all,
          summary: stripped,
          metadata: {}
        });
        sawAnyBlock = true;
        i = next;
        continue;
      }

      const startMatch = stripped.match(/^([A-Z][\w-]+)\s*\(([\s\S]*)$/);
      if (startMatch) {
        const toolName = startMatch[1];
        let argsBuf = startMatch[2];
        let j = i + 1;
        let paren = countParens(argsBuf);
        while (j < lines.length && paren > 0) {
          const next = lines[j];
          const nt = next.clean.trim();
          if (!nt) break;
          if (nt.startsWith('⎿')) break;
          if (isBoundary(next.clean)) break;
          argsBuf += ' ' + nt;
          paren = countParens(argsBuf);
          j++;
        }
        const closeIdx = argsBuf.lastIndexOf(')');
        const toolArgs = closeIdx >= 0 ? argsBuf.slice(0, closeIdx).trim() : argsBuf.trim();
        const r = parseToolUse(toolName, toolArgs, lines, j);
        blocks.push(r.block);
        sawAnyBlock = true;
        i = r.nextIndex;
        continue;
      }

      const r = parseClaudeMessage(stripped, lines, i + 1);
      blocks.push(r.block);
      sawAnyBlock = true;
      i = r.nextIndex;
      continue;
    }

    if (isToolChip(clean)) {
      blocks.push(makeToolChip(clean));
      sawAnyBlock = true;
      i++;
      continue;
    }

    i++;
  }

  if (permissionsBypassed && !blocks.some((b) => b.type === 'permissions_badge')) {
    blocks.unshift(makePermissionsBadge());
  }

  return blocks;
}

function countParens(s: string): number {
  let n = 0;
  for (const c of s) {
    if (c === '(') n++;
    else if (c === ')') n--;
  }
  return n;
}
