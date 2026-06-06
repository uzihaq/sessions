import { useEffect, useMemo, useState } from 'react';
import { useSessions } from '../store/sessions';
import { fetchResumableSessions, type ResumableSession } from '../api/prettyd';
import { getCwdLabel } from '../lib/tabLabels';

// Dedicated resume picker — opened by the ↺ button in the tab strip
// (separate from "+ New session"). The old design tucked resume inside
// a tab on NewSessionDialog, which made it hard to scan: cramped rows,
// 100-char truncation, competing path/size/timestamps. This dialog is
// purpose-built for "which conversation am I picking up?" — message
// is the headline, everything else is quiet metadata.

interface Props {
  onClose: () => void;
  // Click handler if the user wants to abandon resume and start fresh.
  // App.tsx swaps to the New Session dialog so the user doesn't lose
  // their place if the picker turns out to be empty.
  onStartNew: () => void;
}

type ViewMode = 'flat' | 'grouped';

const VIEW_MODE_KEY = 'pretty-pty:resume-view-mode:v1';

function readViewMode(): ViewMode {
  try {
    const v = window.localStorage.getItem(VIEW_MODE_KEY);
    if (v === 'grouped' || v === 'flat') return v;
  } catch { /* ignore */ }
  return 'flat';
}

function writeViewMode(mode: ViewMode): void {
  try { window.localStorage.setItem(VIEW_MODE_KEY, mode); }
  catch { /* ignore */ }
}

function relativeWhen(ms: number): string {
  const diff = Date.now() - ms;
  if (diff < 60_000) return 'just now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  if (diff < 604_800_000) return `${Math.floor(diff / 86_400_000)}d ago`;
  return new Date(ms).toLocaleDateString();
}

function shortFolder(cwd: string): string {
  const friendly = getCwdLabel(cwd);
  if (friendly) return friendly;
  const parts = cwd.split('/').filter(Boolean);
  return parts[parts.length - 1] ?? cwd;
}

function displayPath(cwd: string): string {
  return cwd.startsWith('/Users/uzair')
    ? '~' + cwd.slice('/Users/uzair'.length)
    : cwd;
}

// Mirrors the helper in NewSessionDialog — kept local instead of shared
// because the two dialogs are otherwise independent and the function is
// 6 lines.
function extractClaudeSessionId(args: string[]): string | null {
  for (let i = 0; i < args.length - 1; i++) {
    if (args[i] === '--session-id' || args[i] === '--resume') {
      return args[i + 1] ?? null;
    }
  }
  return null;
}

export function ResumeDialog({ onClose, onStartNew }: Props): JSX.Element {
  const create = useSessions((s) => s.create);
  const openSessions = useSessions((s) => s.sessions);

  const [resumable, setResumable] = useState<ResumableSession[] | null>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<ViewMode>(readViewMode);
  const [query, setQuery] = useState('');

  useEffect(() => {
    let alive = true;
    setLoading(true);
    void fetchResumableSessions()
      .then((s) => { if (alive) { setResumable(s); setLoading(false); } })
      .catch(() => { if (alive) { setResumable(null); setLoading(false); } });
    return () => { alive = false; };
  }, []);

  // Filter out sessions that are already open as prettyd tabs — picking
  // one would spawn a second `claude --resume <id>` against the live
  // JSONL the open tab is writing to, fighting for the file.
  const openClaudeIds = useMemo(() => {
    const ids = new Set<string>();
    for (const s of openSessions) {
      if (s.tool !== 'claude-code') continue;
      const id = extractClaudeSessionId(s.args);
      if (id) ids.add(id);
    }
    return ids;
  }, [openSessions]);

  const available = useMemo(() => {
    if (!resumable) return null;
    const q = query.trim().toLowerCase();
    const list = resumable.filter((s) => !openClaudeIds.has(s.sessionId));
    if (!q) return list;
    return list.filter((s) => {
      const inMsg = s.firstUserMessage?.toLowerCase().includes(q) ?? false;
      const inFolder = shortFolder(s.cwd).toLowerCase().includes(q)
        || s.cwd.toLowerCase().includes(q);
      return inMsg || inFolder;
    });
  }, [resumable, openClaudeIds, query]);

  // Flat = newest-first across all folders. Backend already sorts
  // resumable by modifiedAt desc, so we just keep that order.
  const flatList = available ?? [];

  // Grouped = one section per cwd, sections themselves sorted by their
  // most-recent session's modifiedAt.
  const grouped = useMemo(() => {
    if (!available) return [];
    const map = new Map<string, ResumableSession[]>();
    for (const s of available) {
      const arr = map.get(s.cwd) ?? [];
      arr.push(s);
      map.set(s.cwd, arr);
    }
    return [...map.entries()]
      .map(([cwd, items]) => ({ cwd, items }))
      .sort((a, b) => (b.items[0]?.modifiedAt ?? 0) - (a.items[0]?.modifiedAt ?? 0));
  }, [available]);

  const switchView = (next: ViewMode): void => {
    setView(next);
    writeViewMode(next);
  };

  const resume = async (s: ResumableSession): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      // Skip-perms by default — matches what New Session defaults to,
      // and resuming a conversation where the user had perms granted
      // shouldn't suddenly start asking again.
      await create({
        cmd: 'claude',
        args: ['--dangerously-skip-permissions', '--resume', s.sessionId],
        cwd: s.cwd
      });
      onClose();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const totalAvailable = available?.length ?? 0;
  const hiddenByOpen = (resumable?.length ?? 0) - (available?.length ?? 0)
    + (query.trim() ? 0 : 0); // open-as-tabs hides; query filtering doesn't count
  // hiddenByOpen excludes query filtering — only "in another tab" gets called out.
  const openCount = resumable
    ? resumable.filter((s) => openClaudeIds.has(s.sessionId)).length
    : 0;

  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <div
        className="dialog dialog-wide resume-dialog"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label="Resume a Claude session"
      >
        <header className="resume-dialog-head">
          <div className="resume-dialog-title-row">
            <h2 className="resume-dialog-title">↺ Resume a Claude session</h2>
            <div className="resume-dialog-view-toggle" role="tablist" aria-label="Sort order">
              <button
                type="button"
                role="tab"
                aria-selected={view === 'flat'}
                className={`resume-view-btn${view === 'flat' ? ' is-active' : ''}`}
                onClick={() => switchView('flat')}
                title="Newest first across all folders"
              >Recent</button>
              <button
                type="button"
                role="tab"
                aria-selected={view === 'grouped'}
                className={`resume-view-btn${view === 'grouped' ? ' is-active' : ''}`}
                onClick={() => switchView('grouped')}
                title="One section per folder"
              >By folder</button>
            </div>
          </div>
          <input
            type="text"
            className="resume-dialog-search"
            placeholder={openCount > 0
              ? `Search ${totalAvailable} session${totalAvailable === 1 ? '' : 's'} (${openCount} already open)…`
              : `Search ${totalAvailable} session${totalAvailable === 1 ? '' : 's'}…`}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            autoFocus
          />
        </header>

        <div className="resume-dialog-body">
          {loading ? (
            <div className="resume-empty">Loading sessions…</div>
          ) : resumable === null ? (
            <div className="resume-empty">Could not load sessions.</div>
          ) : flatList.length === 0 ? (
            <div className="resume-empty">
              <p>
                {query.trim()
                  ? `No sessions match "${query.trim()}".`
                  : openCount > 0 && (resumable?.length ?? 0) === openCount
                    ? 'All resumable Claude sessions are already open in tabs.'
                    : 'No prior Claude sessions found on this machine.'}
              </p>
              <button
                type="button"
                className="btn btn-ghost"
                onClick={onStartNew}
              >
                + Start a new session
              </button>
            </div>
          ) : view === 'flat' ? (
            <div className="resume-cards">
              {flatList.map((s) => (
                <ResumeCard key={s.sessionId} session={s} onPick={() => void resume(s)} disabled={busy} />
              ))}
            </div>
          ) : (
            <div className="resume-grouped">
              {grouped.map((g) => (
                <section key={g.cwd} className="resume-group-section">
                  <header className="resume-group-section-head">
                    <span className="resume-group-section-name">{shortFolder(g.cwd)}</span>
                    <span className="resume-group-section-path" title={g.cwd}>{displayPath(g.cwd)}</span>
                    <span className="resume-group-section-count">
                      {g.items.length} session{g.items.length === 1 ? '' : 's'}
                    </span>
                  </header>
                  <div className="resume-cards">
                    {g.items.map((s) => (
                      <ResumeCard
                        key={s.sessionId}
                        session={s}
                        onPick={() => void resume(s)}
                        disabled={busy}
                        hideFolder
                      />
                    ))}
                  </div>
                </section>
              ))}
            </div>
          )}
        </div>

        {error ? <div className="dialog-error">{error}</div> : null}
        <footer className="resume-dialog-foot">
          <button type="button" className="btn btn-ghost" onClick={onStartNew} disabled={busy}>
            + New session instead
          </button>
          <button type="button" className="btn btn-ghost" onClick={onClose} disabled={busy}>
            Close
          </button>
        </footer>
      </div>
    </div>
  );
}

interface CardProps {
  session: ResumableSession;
  onPick: () => void;
  disabled: boolean;
  // In grouped view the folder is already in the section header, so we
  // hide the per-card folder label and let the message column expand.
  hideFolder?: boolean;
}

function ResumeCard({ session, onPick, disabled, hideFolder }: CardProps): JSX.Element {
  const msg = session.firstUserMessage?.trim() || '(no user input yet)';
  const size = session.sizeBytes < 100_000
    ? `${Math.round(session.sizeBytes / 1024)} KB`
    : `${(session.sizeBytes / 1024 / 1024).toFixed(1)} MB`;
  return (
    <button
      type="button"
      className={`resume-card${hideFolder ? ' resume-card-no-folder' : ''}`}
      onClick={onPick}
      disabled={disabled}
      title={`${session.sessionId} · ${size}`}
    >
      {!hideFolder ? (
        <div className="resume-card-left">
          <span className="resume-card-project">{shortFolder(session.cwd)}</span>
          <span className="resume-card-when">{relativeWhen(session.modifiedAt)}</span>
        </div>
      ) : null}
      <div className="resume-card-right">
        <span className="resume-card-msg">{msg}</span>
        {hideFolder ? (
          <span className="resume-card-meta">{relativeWhen(session.modifiedAt)} · {size}</span>
        ) : null}
      </div>
    </button>
  );
}
