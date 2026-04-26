// OpenAI Codex CLI parser.
//
// Built against a real tmux capture (codextest session). Codex's output
// uses different markers from Claude Code:
//
//   › <text>        user input                (U+203A)
//   • <text>        assistant / tool action    (U+2022)
//     └ <text>      sub-output of a block      (U+2514)
//     │ <text>      continuation of a command  (U+2502)
//   ╭─╮ │ │ ╰─╯     boxed banner with "OpenAI Codex (vX.X.X)"
//   ────────────    horizontal rule between turns
//   gpt-5.4 …       bottom status bar (model · context · cwd)
//
// This parser emits the same Block types the Claude Code renderer uses
// (`banner`, `user_input`, `claude_message`, `command`, `tool_use`) so
// everything renders through the existing block components without
// changes.

import type { Block, BlockType } from '../lib/parser';
import { stripAnsi } from '../lib/parser';
import type { ToolParser, WorkingState, SidebarFindings } from './types';

// ──────────────────────────────────────────────────────────────────────
// Helpers

function shortHash(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

let nextSeq = 0;
const seq = (): number => nextSeq++;

function makeBlock(type: BlockType, partial: Partial<Block>): Block {
  return {
    id: partial.id || `${type}-${seq()}`,
    type,
    content: partial.content || '',
    summary: partial.summary || '',
    streaming: partial.streaming,
    metadata: partial.metadata || {}
  };
}

// Boundary check for collecting continuation lines.
function isCodexBoundary(clean: string): boolean {
  const t = clean.trim();
  if (!t) return false;
  if (/^›\s/.test(t) || t === '›') return true;
  if (/^•\s/.test(t)) return true;
  // Banner box edge
  if (/^[╭╰]/.test(t)) return true;
  // Bottom status bar
  if (/^(gpt|claude|o\d)[\w.-]+\s+\w+\s+·\s+[\d%]/.test(t)) return true;
  return false;
}

// Strip a leading ANSI-prefixed marker + its whitespace, matching the
// stripped marker from the raw line. Useful for preserving ANSI in the
// rest of the line while removing just the marker glyph.
function stripLeadingMarker(raw: string, markerChar: string): string {
  // Allow leading whitespace + any ANSI sequences + the marker + space(s)
  const re = new RegExp('^\\s*(?:\\x1b\\[[0-9;]*m)*' + markerChar + '\\s*');
  return raw.replace(re, '');
}

// ──────────────────────────────────────────────────────────────────────
// Main parse

function parseCodex(raw: string): Block[] {
  nextSeq = 0;
  const rawLines = raw.split('\n');
  const cleanLines = rawLines.map((l) => stripAnsi(l));
  const blocks: Block[] = [];

  let i = 0;
  let bannerEmitted = false;

  // Skip past the trust prompt if present (it blocks at session start until
  // the user picks "1. Yes, continue"). We just ignore it in the render.
  const hasTrustPrompt = cleanLines.some((l) => /Do you trust the contents of this directory/i.test(l));
  if (hasTrustPrompt) {
    // Jump to after the trust prompt block
    while (i < cleanLines.length && !/^Press enter to continue/i.test(cleanLines[i].trim())) i++;
    if (i < cleanLines.length) i++; // skip past the "Press enter" line
  }

  while (i < cleanLines.length) {
    const cleanLine = cleanLines[i];
    const rawLine = rawLines[i];
    const trimmed = cleanLine.trim();

    if (!trimmed) { i++; continue; }

    // Banner — boxed `╭─╮ │ >_ OpenAI Codex (vX.X.X) │ ╰─╯`
    if (/^╭[─]+╮/.test(trimmed)) {
      // Collect until the closing ╰─╯ line
      const bannerLines: string[] = [];
      while (i < cleanLines.length) {
        bannerLines.push(cleanLines[i].trim());
        const t = cleanLines[i].trim();
        i++;
        if (/^╰[─]+╯/.test(t)) break;
      }
      if (!bannerEmitted) {
        const joined = bannerLines.join(' ');
        const versionMatch = joined.match(/OpenAI Codex \(v([\w.]+)\)/);
        const modelMatch = joined.match(/model:\s*(\S+)/);
        const cwdMatch = joined.match(/directory:\s*(\S+)/);
        blocks.push(
          makeBlock('banner', {
            id: `banner-${seq()}`,
            summary: versionMatch ? `Codex v${versionMatch[1]}` : 'Codex',
            metadata: {
              version: versionMatch?.[1] || '',
              model: modelMatch?.[1] || '',
              cwd: cwdMatch?.[1] || ''
            }
          })
        );
        bannerEmitted = true;
      }
      continue;
    }

    // Horizontal rules — skip
    if (/^─{3,}$/.test(trimmed)) { i++; continue; }

    // Bottom status bar — `gpt-5.4 default · 90% left · ~`
    if (/^(gpt|claude|o\d)[\w.-]+\s+\w+\s+·/.test(trimmed)) { i++; continue; }

    // Tip banner
    if (/^Tip:/i.test(trimmed)) { i++; continue; }

    // User input: `› <text>`
    if (/^›\s/.test(trimmed) || trimmed === '›') {
      const userText = trimmed.replace(/^›\s*/, '').trim();
      if (!userText) { i++; continue; }
      // Collect indented continuation lines (Codex soft-wraps user input
      // the same way Claude Code does — leading 2-space indent).
      let fullText = userText;
      let j = i + 1;
      while (j < cleanLines.length) {
        const nt = cleanLines[j].trim();
        if (!nt) break;
        if (isCodexBoundary(cleanLines[j])) break;
        if (!/^\s/.test(cleanLines[j])) break;
        fullText += '\n' + cleanLines[j].replace(/^ {1,2}/, '').trimEnd();
        j++;
      }
      blocks.push(
        makeBlock('user_input', {
          id: `user-${seq()}-${shortHash(userText.slice(0, 40))}`,
          content: fullText,
          summary: userText.slice(0, 80),
          metadata: { responses: [] }
        })
      );
      i = j;
      continue;
    }

    // Assistant block: `• <text>`. Sub-types based on the first word:
    //   • Ran <cmd>      → command
    //   • Explored       → tool_use
    //   • <anything else>→ claude_message
    if (/^•\s/.test(trimmed)) {
      const firstLine = trimmed.replace(/^•\s*/, '');
      let type: BlockType = 'claude_message';
      let toolName = '';
      let cmdBuf = '';
      const ranMatch = firstLine.match(/^Ran\s+(.+)$/);
      const exploredMatch = firstLine.match(/^Explored\s*(.*)$/);
      if (ranMatch) {
        type = 'command';
        toolName = 'Bash';
        cmdBuf = ranMatch[1];
      } else if (exploredMatch) {
        type = 'tool_use';
        toolName = 'Explore';
      }

      // Collect continuation lines until the next boundary.
      const bodyClean: string[] = [];
      const bodyRaw: string[] = [];
      let j = i + 1;
      while (j < cleanLines.length) {
        const nextClean = cleanLines[j];
        const nextRaw = rawLines[j];
        const nt = nextClean.trim();
        if (!nt) { bodyClean.push(''); bodyRaw.push(''); j++; continue; }
        if (isCodexBoundary(nextClean)) break;
        if (!/^\s/.test(nextClean)) break;
        // │ continuation of a command on the first line
        if (type === 'command' && /^\s*│\s/.test(nextClean)) {
          cmdBuf += ' ' + nt.replace(/^│\s*/, '');
          j++;
          continue;
        }
        // └ start of sub-output / tool output
        if (/^\s*└\s/.test(nextClean)) {
          bodyClean.push(nt.replace(/^└\s*/, ''));
          bodyRaw.push(stripLeadingMarker(nextRaw, '└'));
          j++;
          continue;
        }
        // Plain indented continuation line
        bodyClean.push(nextClean.replace(/^ {2,6}/, ''));
        bodyRaw.push(nextRaw.replace(/^ {2,6}/, '').trimEnd());
        j++;
      }
      // Trim trailing blanks
      while (bodyClean.length && !bodyClean[bodyClean.length - 1].trim()) {
        bodyClean.pop();
        bodyRaw.pop();
      }

      const bodyJoined = bodyRaw.join('\n');

      if (type === 'command') {
        blocks.push(
          makeBlock('command', {
            id: `cmd-${seq()}-${shortHash(cmdBuf.slice(0, 60))}`,
            content: bodyJoined,
            summary: cmdBuf,
            metadata: {
              toolName: 'Bash',
              toolArgs: cmdBuf,
              tool: 'Bash',
              command: cmdBuf,
              output: bodyJoined
            }
          })
        );
      } else if (type === 'tool_use') {
        blocks.push(
          makeBlock('tool_use', {
            id: `tool-${seq()}-${shortHash(firstLine.slice(0, 40))}`,
            content: bodyJoined,
            summary: exploredMatch?.[1] || 'Explored',
            metadata: {
              toolName,
              toolArgs: exploredMatch?.[1] || '',
              tool: toolName
            }
          })
        );
      } else {
        // claude_message — join firstLine + body
        const all = [firstLine, ...bodyRaw].join('\n').replace(/\n+$/, '');
        blocks.push(
          makeBlock('claude_message', {
            id: `codex-${seq()}-${shortHash(firstLine.slice(0, 40))}`,
            content: all,
            summary: firstLine.slice(0, 80),
            metadata: {}
          })
        );
      }
      i = j;
      continue;
    }

    // Numbered trust prompt options we didn't skip at the top for some
    // reason — ignore them so they don't render as unknown text.
    if (/^\d+\.\s/.test(trimmed)) { i++; continue; }

    // Unknown / unrecognized — skip silently rather than render raw chrome.
    i++;
  }

  return blocks;
}

// ──────────────────────────────────────────────────────────────────────
// ToolParser export

export const codexParser: ToolParser = {
  id: 'codex',
  name: 'Codex',
  icon: '🟢',

  detect(raw: string): boolean {
    const clean = stripAnsi(raw);
    return (
      /OpenAI Codex \(v[\w.]+\)/.test(clean) ||
      // User input marker + bottom status bar is also a strong signal
      (/(^|\n)\s*›\s+/.test(clean) && /(gpt|o\d)[\w.-]+\s+\w+\s+·/.test(clean))
    );
  },

  parse(raw: string): Block[] {
    return parseCodex(raw);
  },

  workingState(raw: string): WorkingState {
    const clean = stripAnsi(raw);
    const lines = clean.split('\n').map((l) => l.trimEnd()).filter(Boolean);
    // Walk the last few non-empty lines looking for an idle prompt.
    // Codex's idle state: bottom status bar (`gpt-5.4 default · 90% left · ~`)
    // with an empty `›` prompt just above it.
    for (let k = lines.length - 1; k >= 0 && k > lines.length - 6; k--) {
      const t = lines[k].trim();
      if (!t) continue;
      if (/^(gpt|claude|o\d)[\w.-]+\s+\w+\s+·/.test(t)) continue; // status bar
      // Empty prompt → idle
      if (t === '›' || /^›\s*$/.test(t)) return { working: false };
      // Non-empty recent activity → working (conservative)
      return { working: true };
    }
    return { working: false };
  },

  extractSidebarFindings(raw: string, parsed: Block[]): SidebarFindings {
    const findings: SidebarFindings = {};

    // cwd from the banner
    for (const b of parsed) {
      if (b.type === 'banner' && b.metadata.cwd) {
        findings.cwd = b.metadata.cwd;
        break;
      }
    }

    // Current task = last user_input
    for (let i = parsed.length - 1; i >= 0; i--) {
      if (parsed[i].type === 'user_input') {
        const content = parsed[i].content;
        findings.currentTask = content.length > 80 ? content.slice(0, 80) + '…' : content;
        break;
      }
    }

    // Stats — turns (user_inputs) + tools (commands + explores)
    let turns = 0;
    let tools = 0;
    for (const b of parsed) {
      if (b.type === 'user_input') turns++;
      if (b.type === 'tool_use' || b.type === 'command') tools++;
    }
    findings.stats = { turns, tools, tokenSum: 0 };

    return findings;
  },

  pollInterval(working: boolean): number {
    return working ? 400 : 3000;
  }
};
