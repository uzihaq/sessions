import { useEffect, useState } from 'react';
import { useSessions } from '../store/sessions';
import { NewSessionDialog } from './NewSessionDialog';

function shortId(id: string): string {
  return id.slice(0, 8);
}

function timeAgo(ms: number): string {
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  return `${h}h`;
}

export function Sidebar(): JSX.Element {
  const { sessions, activeId, refresh, kill, setActive } = useSessions();
  const [dialogOpen, setDialogOpen] = useState(false);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return (
    <aside className="sidebar">
      <header className="sidebar-header">
        <h1 className="sidebar-title">pretty-PTY</h1>
        <button className="btn btn-primary" onClick={() => setDialogOpen(true)}>
          + New
        </button>
      </header>

      <ul className="session-list">
        {sessions.length === 0 ? (
          <li className="session-empty">no sessions</li>
        ) : (
          sessions.map((s) => (
            <li
              key={s.id}
              className={`session-item ${s.id === activeId ? 'is-active' : ''}`}
              onClick={() => setActive(s.id)}
            >
              <div className="session-line">
                <span className="session-cmd">{s.cmd}</span>
                <span className="session-meta">{shortId(s.id)} · {timeAgo(s.createdAt)}</span>
              </div>
              <button
                className="btn btn-ghost session-kill"
                onClick={(e) => {
                  e.stopPropagation();
                  void kill(s.id);
                }}
                title="kill session"
              >
                ×
              </button>
            </li>
          ))
        )}
      </ul>

      {dialogOpen ? <NewSessionDialog onClose={() => setDialogOpen(false)} /> : null}
    </aside>
  );
}
