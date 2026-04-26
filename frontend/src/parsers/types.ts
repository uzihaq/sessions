// Plugin interface for tool-specific parsers.
//
// Each tool (Claude Code, Codex, plain terminal, …) implements this
// contract and gets registered in `src/parsers/detect.ts`. App.tsx
// detects the tool once per session, caches the parser, and dispatches
// all poll-time work through the parser's methods.
//
// IMPORTANT: parsers are stateless. They see ONE poll's capture and
// return transient findings. All stateful display logic (latching,
// frozen prefix, own-clock timer, localStorage, file accumulation, …)
// lives in App.tsx. This keeps each new parser small and prevents the
// latching rules from drifting out of sync across tools.

import type { Block } from '../lib/parser';
import type {
  SidebarChecklistItem,
  FileTouchKind
} from '../components/StatusSidebar';

export interface WorkingState {
  /** True if the tool is actively working right now. */
  working: boolean;
  /** If a "done" marker is visible (e.g. Claude Code's ✻ Baked for X),
   * the captured duration string. App.tsx freezes this as the sidebar's
   * "last run" display. */
  finalElapsed?: string;
}

export interface SidebarFindings {
  /** Displayed thinking timer, e.g. "7m 35s". App.tsx back-dates its
   * own clock from this on first sighting, then ticks independently. */
  timer?: string;
  /** Token count, e.g. "1.9k". Latched in App.tsx. */
  tokens?: string;
  /** Effort level, e.g. "high effort". Latched. */
  effort?: string;
  /** Last user input, truncated. Latched. */
  currentTask?: string;
  /** Checklist items found in THIS poll's view. App.tsx replaces the
   * displayed list only if this is non-empty. */
  checklistItems?: SidebarChecklistItem[];
  /** Files touched in THIS poll's view. App.tsx accumulates into a
   * Map<filename, kind> that only grows. */
  filesSeen?: { filename: string; kind: FileTouchKind }[];
  /** Working directory (for file-link building). May be tilde-prefixed —
   * App.tsx expands via the relay's home action. */
  cwd?: string;
  /** Per-poll counts. App.tsx applies a high-water mark per field. */
  stats?: { turns: number; tools: number; tokenSum: number };
}

export interface ToolParser {
  /** Unique identifier. */
  id: string;
  /** Display name for the sidebar / tab tooltip. */
  name: string;
  /** Short glyph shown in tabs. */
  icon: string;
  /** Return true if this parser should handle the given capture.
   * Checked in order; the first match wins. `terminal` always matches. */
  detect(raw: string): boolean;
  /** Parse raw capture into typed blocks. */
  parse(raw: string): Block[];
  /** Determine working / done state for the sidebar timer. */
  workingState(raw: string): WorkingState;
  /** Extract transient sidebar findings. Optional — terminal doesn't
   * bother. */
  extractSidebarFindings?(raw: string, blocks: Block[]): SidebarFindings;
  /** Recommended poll interval in ms. App.tsx still adapts around this
   * (slow when idle, fast when working). */
  pollInterval(working: boolean): number;
}
