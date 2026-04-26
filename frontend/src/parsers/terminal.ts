// Terminal passthrough — the always-matches fallback parser.
//
// Any tmux pane that isn't Claude Code or Codex gets routed here. Rather
// than trying to classify arbitrary shell output into structured blocks,
// we emit a SINGLE `terminal_passthrough` block containing the entire
// raw capture (including ANSI escapes). The TerminalBlock React
// component renders it through xterm.js for interactive use.

import type { Block } from '../lib/parser';
import type { ToolParser, WorkingState, SidebarFindings } from './types';

export const terminalParser: ToolParser = {
  id: 'terminal',
  name: 'Terminal',
  icon: '⬛',

  detect(): boolean {
    // Always matches — this is the fallback when no other parser did.
    return true;
  },

  parse(raw: string): Block[] {
    return [
      {
        id: 'terminal-output', // singleton — same id every poll, React reuses the mount
        type: 'terminal_passthrough',
        content: raw,
        summary: '',
        metadata: {}
      }
    ];
  },

  workingState(): WorkingState {
    // Generic shells don't have a machine-readable "working" signal,
    // so we always report idle. The terminal view itself doesn't need
    // an explicit working indicator — the user can see the cursor.
    return { working: false };
  },

  extractSidebarFindings(): SidebarFindings {
    // No structured metadata to show in the sidebar for a plain terminal.
    return {};
  },

  pollInterval(): number {
    // Snappy polling for interactive use. Echo latency = poll interval
    // in the worst case (from keystroke to visible echo).
    return 150;
  }
};
