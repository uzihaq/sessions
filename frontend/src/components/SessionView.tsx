import { useEffect, useState } from 'react';
import { useTerminal } from '../hooks/useTerminal';
import { usePrettyParser } from '../hooks/usePrettyParser';
import { PrettyView } from './PrettyView';
import StatusSidebar from './StatusSidebar';

interface Props {
  sessionId: string;
}

type ViewMode = 'terminal' | 'pretty' | 'split';

const VIEW_KEY = 'pretty-pty:viewMode';

function readStoredView(): ViewMode {
  try {
    const v = window.localStorage.getItem(VIEW_KEY);
    if (v === 'terminal' || v === 'pretty' || v === 'split') return v;
  } catch {
    // ignore
  }
  return 'split';
}

function writeStoredView(mode: ViewMode): void {
  try {
    window.localStorage.setItem(VIEW_KEY, mode);
  } catch {
    // ignore
  }
}

// Owns useTerminal + usePrettyParser for the active session and exposes a
// Terminal / Pretty / Split layout. The terminal stream is the source of
// truth — its xterm instance stays mounted across mode toggles so a parser
// hiccup never takes the raw terminal away from the user.
export function SessionView({ sessionId }: Props): JSX.Element {
  const term = useTerminal(sessionId);
  const parser = usePrettyParser({
    sessionId,
    writeTick: term.writeTick,
    getSnapshotRef: term.getSnapshotRef
  });

  const [viewMode, setViewMode] = useState<ViewMode>(readStoredView);

  useEffect(() => {
    writeStoredView(viewMode);
  }, [viewMode]);

  return (
    <div className={`session-view view-${viewMode}`}>
      <div className="session-toolbar">
        <span className={`status-dot status-${term.status}`} />
        <span className="status-text">{term.status}</span>
        {term.resumedFromSeq !== null && term.resumedFromSeq > 0 ? (
          <span className="status-resumed">resumed from seq {term.resumedFromSeq}</span>
        ) : null}
        <span className="session-parser">
          <span aria-hidden>{parser.sidebar.parserIcon}</span>
          <span>{parser.sidebar.parserName}</span>
        </span>
        {term.exitInfo ? (
          <span className="status-exit">
            exited code={term.exitInfo.code ?? '∅'} signal={term.exitInfo.signal ?? '∅'}
          </span>
        ) : null}
        <div className="view-toggle" role="tablist" aria-label="view mode">
          <button
            type="button"
            className={`view-toggle-btn${viewMode === 'terminal' ? ' is-active' : ''}`}
            onClick={() => setViewMode('terminal')}
          >
            Terminal
          </button>
          <button
            type="button"
            className={`view-toggle-btn${viewMode === 'split' ? ' is-active' : ''}`}
            onClick={() => setViewMode('split')}
          >
            Split
          </button>
          <button
            type="button"
            className={`view-toggle-btn${viewMode === 'pretty' ? ' is-active' : ''}`}
            onClick={() => setViewMode('pretty')}
          >
            Pretty
          </button>
        </div>
      </div>

      {/* xterm host stays in the DOM in all modes so SerializeAddon keeps
          producing snapshots. CSS hides whichever pane the active view-mode
          doesn't want, but never zeroes the terminal-host dims. */}
      <div className="session-body">
        <div className="session-terminal-pane">
          <div className="terminal-host" ref={term.containerRef} />
        </div>
        <div className="session-pretty-pane">
          <div className="pretty-scroll">
            <PrettyView blocks={parser.blocks} />
          </div>
          <StatusSidebar
            parserName={parser.sidebar.parserName}
            parserIcon={parser.sidebar.parserIcon}
            isWorking={parser.sidebar.isWorking}
            timer={parser.sidebar.timer}
            tokens={parser.sidebar.tokens}
            effort={parser.sidebar.effort}
            finalElapsed={parser.sidebar.finalElapsed}
            currentTask={parser.sidebar.currentTask}
            checklist={parser.sidebar.checklist}
            files={parser.sidebar.files}
          />
        </div>
      </div>
    </div>
  );
}
