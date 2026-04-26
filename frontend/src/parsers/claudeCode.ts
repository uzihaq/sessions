// Claude Code parser wrapped in the ToolParser interface.
//
// Delegates the heavy lifting to the existing `parseClaudeOutput` in
// src/lib/parser.ts (which is ~700 lines and well-tuned). This module
// adds the stateless per-poll hooks the plugin interface needs:
// detect / workingState / extractSidebarFindings / pollInterval.
//
// All stateful display logic (latching, own-clock timer, frozen prefix,
// file accumulation, localStorage, finalElapsed reset on idle→working,
// …) stays in App.tsx. The findings returned here are raw "what did
// THIS poll see" values — App.tsx is responsible for merging them into
// the live UI state.

import type { Block } from '../lib/parser';
import { parseClaudeOutput, stripAnsi } from '../lib/parser';
import type { ToolParser, WorkingState, SidebarFindings } from './types';
import type {
  SidebarChecklistItem,
  FileTouchKind
} from '../components/StatusSidebar';

const POLL_FAST = 200;
const POLL_SLOW = 3000;
const TASK_TRUNCATE = 80;

function fileKindFor(toolName: string): FileTouchKind | null {
  const n = toolName.toLowerCase();
  if (n === 'read') return 'read';
  if (n === 'write' || n === 'create') return 'write';
  if (n === 'edit' || n === 'update') return 'edit';
  return null;
}

function parseTokenString(s: string): number {
  const m = s.match(/^([\d.]+)\s*([kKmM])?/);
  if (!m) return 0;
  const n = parseFloat(m[1]);
  const suffix = (m[2] || '').toLowerCase();
  if (suffix === 'k') return n * 1_000;
  if (suffix === 'm') return n * 1_000_000;
  return n;
}

export const claudeCodeParser: ToolParser = {
  id: 'claude-code',
  name: 'Claude Code',
  icon: '🟠',

  detect(raw: string): boolean {
    const clean = stripAnsi(raw);
    // Any one of these is a strong Claude Code signal. We check multiple
    // so a scrolled-off banner doesn't disqualify a session that's still
    // clearly running Claude Code (⏺ + ❯ markers in active use).
    return (
      /▐▛███▜▌/.test(clean) ||
      /Claude Code v\d/.test(clean) ||
      /⏵⏵ bypass permissions/.test(clean) ||
      (/(^|\n)\s*⏺\s+/.test(clean) && /(^|\n)\s*❯/.test(clean))
    );
  },

  parse(raw: string): Block[] {
    return parseClaudeOutput(raw);
  },

  workingState(raw: string): WorkingState {
    const cleanRaw = stripAnsi(raw);
    const allLines = cleanRaw.split('\n');
    const tail60 = allLines.slice(Math.max(0, allLines.length - 60));
    const tail60Text = tail60.join('\n');

    const hasThinking = /(^|\n)\s*✳\s+\w+…\s*\(/.test(tail60Text);
    const hasRunning = /(^|\n)\s*⎿\s*(Running|Bunning)…/.test(tail60Text);

    // ✻ done marker — only check when NOT currently thinking so an old
    // "Worked for X" from a previous turn doesn't override an active ✳
    // from the current turn.
    let bakedFor: string | null = null;
    if (!hasThinking && !hasRunning) {
      for (let k = tail60.length - 1; k >= 0; k--) {
        const m = tail60[k].match(/^\s*✻\s+\S+\s+for\s+([\dhms\s]+)/);
        if (m) {
          const dur = m[1].trim();
          if (/[hms]$/.test(dur)) { bakedFor = dur; break; }
        }
      }
    }

    // Walk the last few non-empty lines from the bottom and skip terminal
    // chrome to find the trailing ❯ prompt.
    const tailLines = allLines.map((l) => l.trimEnd()).filter(Boolean);
    let endsWithPrompt = false;
    for (let k = tailLines.length - 1; k >= 0 && k > tailLines.length - 8; k--) {
      const t = tailLines[k].trim();
      if (!t) continue;
      if (t.startsWith('⏵⏵')) continue;
      if (/^─{3,}$/.test(t)) continue;
      if (/^\?\s+for shortcuts$/i.test(t)) continue;
      endsWithPrompt = /^❯(\s|$)/.test(t);
      break;
    }

    const working = hasThinking || hasRunning || (!bakedFor && !endsWithPrompt);
    return { working, finalElapsed: bakedFor || undefined };
  },

  extractSidebarFindings(raw: string, parsed: Block[]): SidebarFindings {
    const findings: SidebarFindings = {};

    // cwd from the most recent banner. May be tilde-prefixed; App.tsx
    // handles the expansion.
    for (let i = parsed.length - 1; i >= 0; i--) {
      if (parsed[i].type === 'banner' && parsed[i].metadata.cwd) {
        findings.cwd = parsed[i].metadata.cwd;
        break;
      }
    }

    // Global token regex — works whether or not the line made it into
    // a thinking_active block.
    const tokenMatch = raw.match(/↓\s*([\d.,]+\s*[kKmM]?)\s*tokens/);
    if (tokenMatch) findings.tokens = tokenMatch[1].trim();

    // Effort and displayed timer from the thinking_active block (if any)
    const thinking = parsed.find((b) => b.type === 'thinking_active');
    if (thinking) {
      if (thinking.metadata.timer) findings.timer = thinking.metadata.timer;
      const effortMatch = raw.match(/(high|medium|low)\s+effort/i);
      if (effortMatch) findings.effort = `${effortMatch[1].toLowerCase()} effort`;
    }

    // Current task — last user_input
    for (let i = parsed.length - 1; i >= 0; i--) {
      if (parsed[i].type === 'user_input') {
        const content = parsed[i].content;
        findings.currentTask = content.length > TASK_TRUNCATE
          ? content.slice(0, TASK_TRUNCATE) + '…'
          : content;
        break;
      }
    }

    // Checklist — last group of 2+ consecutive check/square lines.
    {
      const allLines = raw.split('\n');
      let lastGroup: SidebarChecklistItem[] = [];
      let cur: SidebarChecklistItem[] = [];
      const flushGroup = () => {
        if (cur.length >= 2) lastGroup = cur;
        cur = [];
      };
      for (const rawLine of allLines) {
        const cleanLine = rawLine.replace(/\x1b\[[0-9;]*m/g, '').trim();
        const doneMatch = cleanLine.match(/^[✓✔☑]\s+(\S.*)$/);
        const activeMatch = cleanLine.match(/^◼\s+(\S.*)$/);
        const pendingMatch = cleanLine.match(/^[◻☐□]\s+(\S.*)$/);
        if (doneMatch) cur.push({ text: doneMatch[1].trim(), status: 'done' });
        else if (activeMatch) cur.push({ text: activeMatch[1].trim(), status: 'active' });
        else if (pendingMatch) cur.push({ text: pendingMatch[1].trim(), status: 'pending' });
        else flushGroup();
      }
      flushGroup();
      if (lastGroup.length > 0) findings.checklistItems = lastGroup;
    }

    // Files seen in this poll (Read / Write / Edit only)
    const filesSeen: { filename: string; kind: FileTouchKind }[] = [];
    for (const block of parsed) {
      if (block.type === 'tool_use' || block.type === 'command') {
        const name = block.metadata.toolName || '';
        const kind = fileKindFor(name);
        if (kind) {
          const filename = (block.metadata.toolArgs || '').trim();
          if (filename && filename.length < 200) {
            filesSeen.push({ filename, kind });
          }
        }
      }
    }
    if (filesSeen.length > 0) findings.filesSeen = filesSeen;

    // Stats — per-poll counts
    let turns = 0;
    let tools = 0;
    let tokenSum = 0;
    for (const block of parsed) {
      if (block.type === 'user_input') turns++;
      if (block.type === 'tool_use' || block.type === 'command') tools++;
      const ds = block.metadata.doneSummary;
      if (ds) {
        const m = ds.match(/([\d.]+\s*[kKmM]?)\s*tokens/);
        if (m) tokenSum += parseTokenString(m[1]);
      }
    }
    findings.stats = { turns, tools, tokenSum };

    return findings;
  },

  pollInterval(working: boolean): number {
    return working ? POLL_FAST : POLL_SLOW;
  }
};
