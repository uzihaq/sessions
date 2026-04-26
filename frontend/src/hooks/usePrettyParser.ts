import { useEffect, useMemo, useRef, useState } from 'react';
import type { Block } from '../lib/parser';
import type { ToolParser, SidebarFindings } from '../parsers/types';
import type {
  SidebarChecklistItem,
  SidebarFileEntry,
  FileTouchKind
} from '../types/sidebar';
import { detectTool, redetectIfStale } from '../parsers/detect';
import { terminalParser } from '../parsers/terminal';

// Trailing-edge throttle: every burst of writes triggers exactly one parse
// THROTTLE_MS later. Unlike a plain debounce, a continuous stream of writes
// still produces a parse every THROTTLE_MS instead of starving until the
// stream pauses.
const THROTTLE_MS = 200;

export interface SidebarState {
  parserId: string;
  parserName: string;
  parserIcon: string;
  isWorking: boolean;
  timer: string;
  tokens: string;
  effort: string;
  finalElapsed: string;
  currentTask: string;
  checklist: SidebarChecklistItem[];
  files: SidebarFileEntry[];
}

const EMPTY_SIDEBAR: SidebarState = {
  parserId: terminalParser.id,
  parserName: terminalParser.name,
  parserIcon: terminalParser.icon,
  isWorking: false,
  timer: '',
  tokens: '',
  effort: '',
  finalElapsed: '',
  currentTask: '',
  checklist: [],
  files: []
};

export interface ParserResult {
  blocks: Block[];
  sidebar: SidebarState;
  parser: ToolParser;
}

interface Args {
  sessionId: string | null;
  writeTick: number;
  getSnapshotRef: { current: () => string };
}

// Subscribes to writeTick, throttles the re-parse, runs detect → parse →
// extractSidebarFindings, and latches sidebar state across snapshots so a
// single dropped frame doesn't blank the timer / file list.
export function usePrettyParser({ sessionId, writeTick, getSnapshotRef }: Args): ParserResult {
  const [blocks, setBlocks] = useState<Block[]>([]);
  const [sidebar, setSidebar] = useState<SidebarState>(EMPTY_SIDEBAR);

  const parserRef = useRef<ToolParser | null>(null);
  // Files-touched accumulator (Map<filename, kind>) — only grows.
  const filesRef = useRef<Map<string, FileTouchKind>>(new Map());
  const throttleRef = useRef<number | null>(null);

  // Reset latches whenever the active session changes.
  useEffect(() => {
    parserRef.current = null;
    filesRef.current = new Map();
    setBlocks([]);
    setSidebar(EMPTY_SIDEBAR);
  }, [sessionId]);

  useEffect(() => {
    if (!sessionId) return;
    // Trailing-edge throttle: if a parse is already pending, just let it
    // fire — DON'T cancel-and-reschedule, or a continuous output stream
    // would starve the parse forever (every writeTick clears the timer).
    if (throttleRef.current !== null) return;

    throttleRef.current = window.setTimeout(() => {
      throttleRef.current = null;
      const snapshot = getSnapshotRef.current();
      if (!snapshot) return;

      const parser = parserRef.current
        ? redetectIfStale(parserRef.current, snapshot)
        : detectTool(snapshot);
      parserRef.current = parser;

      const parsed = parser.parse(snapshot);
      const findings: SidebarFindings = parser.extractSidebarFindings
        ? parser.extractSidebarFindings(snapshot, parsed)
        : {};
      const working = parser.workingState(snapshot);

      if (findings.filesSeen) {
        for (const f of findings.filesSeen) {
          filesRef.current.set(f.filename, f.kind);
        }
      }
      const fileEntries: SidebarFileEntry[] = [...filesRef.current.entries()].map(
        ([filename, kind]) => ({ filename, kind })
      );

      setBlocks(parsed);
      setSidebar((prev) => ({
        parserId: parser.id,
        parserName: parser.name,
        parserIcon: parser.icon,
        isWorking: working.working,
        // Latch live values: keep last known when the parser drops them
        // mid-redraw (xterm reflow can blank these for a single tick).
        timer: findings.timer ?? (working.working ? prev.timer : ''),
        tokens: findings.tokens ?? (working.working ? prev.tokens : ''),
        effort: findings.effort ?? (working.working ? prev.effort : ''),
        finalElapsed: working.finalElapsed ?? prev.finalElapsed,
        currentTask: findings.currentTask ?? prev.currentTask,
        checklist:
          findings.checklistItems && findings.checklistItems.length > 0
            ? findings.checklistItems
            : prev.checklist,
        files: fileEntries
      }));
    }, THROTTLE_MS);

    // No cleanup on dep change — the pending timer is *load-bearing* for
    // the throttle. Unmount cleanup happens in the separate effect below.
    // writeTick is the trigger; getSnapshotRef is a stable ref so React
    // doesn't need it in deps.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [writeTick, sessionId]);

  useEffect(() => {
    return () => {
      if (throttleRef.current !== null) {
        window.clearTimeout(throttleRef.current);
        throttleRef.current = null;
      }
    };
  }, []);

  return useMemo(
    () => ({
      blocks,
      sidebar,
      parser: parserRef.current ?? terminalParser
    }),
    [blocks, sidebar]
  );
}
