import { useTerminal } from '../hooks/useTerminal';

interface Props {
  sessionId: string;
}

export function TerminalPane({ sessionId }: Props): JSX.Element {
  const { containerRef, status, exitInfo, resumedFromSeq } = useTerminal(sessionId);
  return (
    <div className="terminal-pane">
      <div className="terminal-statusline">
        <span className={`status-dot status-${status}`} />
        <span className="status-text">{status}</span>
        {resumedFromSeq !== null && resumedFromSeq > 0 ? (
          <span className="status-resumed">resumed from seq {resumedFromSeq}</span>
        ) : null}
        {exitInfo ? (
          <span className="status-exit">
            exited code={exitInfo.code ?? '∅'} signal={exitInfo.signal ?? '∅'}
          </span>
        ) : null}
      </div>
      <div ref={containerRef} className="terminal-host" />
    </div>
  );
}
