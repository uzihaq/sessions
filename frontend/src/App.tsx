import { useState } from 'react';
import { Sidebar } from './components/Sidebar';
import { TerminalPane } from './components/Terminal';
import { EmptyState } from './components/EmptyState';
import { NewSessionDialog } from './components/NewSessionDialog';
import { useSessions } from './store/sessions';

export function App(): JSX.Element {
  const activeId = useSessions((s) => s.activeId);
  const [emptyDialogOpen, setEmptyDialogOpen] = useState(false);

  return (
    <div className="app-shell">
      <Sidebar />
      <main className="app-main">
        {activeId ? (
          <TerminalPane key={activeId} sessionId={activeId} />
        ) : (
          <EmptyState onNew={() => setEmptyDialogOpen(true)} />
        )}
      </main>
      {emptyDialogOpen ? <NewSessionDialog onClose={() => setEmptyDialogOpen(false)} /> : null}
    </div>
  );
}
