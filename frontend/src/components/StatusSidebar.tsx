// StatusSidebar — pure render. All data is extracted in usePrettyParser
// and passed in as props so this component never touches the parser
// directly.

import type {
  FileTouchKind,
  SidebarChecklistItem,
  SidebarFileEntry
} from '../types/sidebar';

export type { FileTouchKind, SidebarChecklistItem, SidebarFileEntry };

export interface SidebarStats {
  totalTime: string; // formatted "23m" / "1h 5m" / "45s"
  turns: number;
  tools: number;
  tokens: string; // formatted "78.2k" or "—"
}

export interface SidebarProps {
  parserName: string;
  parserIcon: string;
  isWorking: boolean;
  timer: string;          // "7m 35s" — empty when idle
  tokens: string;         // "1.9k" — empty when idle
  effort: string;         // "high effort" — empty when idle
  finalElapsed: string;   // "9m 50s" frozen from ✻ baked-for line, empty if no recent run
  currentTask: string;    // truncated last user input
  checklist: SidebarChecklistItem[];
  files: SidebarFileEntry[];
  stats?: SidebarStats;
}

function fileBadgeLabel(kind: FileTouchKind): string {
  if (kind === 'write') return 'new';
  if (kind === 'edit') return 'mod';
  return 'read';
}

export default function StatusSidebar({
  parserName,
  parserIcon,
  isWorking,
  timer,
  tokens,
  effort,
  finalElapsed,
  currentTask,
  checklist,
  files,
  stats
}: SidebarProps) {
  return (
    <aside className="status-sidebar">
      <section className="sidebar-section sidebar-parser">
        <span className="sidebar-parser-icon">{parserIcon}</span>
        <span className="sidebar-parser-name">{parserName}</span>
      </section>

      <section className="sidebar-section">
        <div className="status-row">
          <span className={'status-dot ' + (isWorking ? 'working' : 'idle')} />
          <span className="status-text">{isWorking ? 'Working' : 'Ready'}</span>
        </div>
        {isWorking ? (
          <>
            <div className="timer-display">{timer || '—'}</div>
            <div className="timer-sub">
              {tokens ? `${tokens} tokens` : ''}
              {tokens && effort ? ' · ' : ''}
              {effort}
            </div>
          </>
        ) : finalElapsed ? (
          <>
            <div className="timer-display">{finalElapsed}</div>
            <div className="timer-sub">last run</div>
          </>
        ) : (
          <div className="timer-sub">idle</div>
        )}
      </section>

      {currentTask && (
        <section className="sidebar-section">
          <div className="sidebar-label">Current</div>
          <div className="current-task">{currentTask}</div>
        </section>
      )}

      {checklist.length > 0 && (
        <section className="sidebar-section">
          <div className="sidebar-label">Progress</div>
          {checklist.map((item, i) => (
            <div key={i} className={'checklist-item ' + item.status}>
              <span className="checklist-mark">
                {item.status === 'done' ? '✓' : item.status === 'active' ? '◼' : '◻'}
              </span>
              <span className="checklist-text">{item.text}</span>
            </div>
          ))}
        </section>
      )}

      {files.length > 0 && (
        <section className="sidebar-section">
          <div className="sidebar-label">Files</div>
          {files.map((f) => (
            <div key={f.filename} className="file-row">
              <span className="file-name" title={f.filename}>{f.filename}</span>
              <span className={'file-badge ' + f.kind}>{fileBadgeLabel(f.kind)}</span>
            </div>
          ))}
        </section>
      )}

      {stats && (
        <section className="sidebar-section">
          <div className="sidebar-label">Session</div>
          <div className="stat-row">
            <span className="stat-label">Turns</span>
            <span className="stat-value">{stats.turns}</span>
          </div>
          <div className="stat-row">
            <span className="stat-label">Tools</span>
            <span className="stat-value">{stats.tools}</span>
          </div>
          <div className="stat-row">
            <span className="stat-label">Tokens</span>
            <span className="stat-value">{stats.tokens}</span>
          </div>
        </section>
      )}
    </aside>
  );
}
