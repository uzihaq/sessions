import { useEffect, useMemo, useState } from 'react';
import { useSessions } from '../store/sessions';
import { adoptConversation, fetchResumableSessions, type ResumableSession } from '../api/sessionsd';
import { getCwdLabel } from '../lib/tabLabels';
import { ProviderBadge } from './ProviderBadge';

// Dedicated resume picker — opened by the ↺ button in the tab strip
// (separate from "+ New session"). The old design tucked resume inside
// a tab on NewSessionDialog, which made it hard to scan: cramped rows,
// 100-char truncation, competing path/size/timestamps. This dialog is
// purpose-built for "which conversation am I picking up?" — message
// is the headline, everything else is quiet metadata.

interface Props {
  onClose: () => void;
  onResumed: (laneId: string) => void;
  preferredProviderId?: string;
  // Click handler if the user wants to abandon resume and start fresh.
  // App.tsx swaps to the New Session dialog so the user doesn't lose
  // their place if the picker turns out to be empty.
  onStartNew: () => void;
}

type ViewMode = 'flat' | 'grouped';

const VIEW_MODE_KEY = 'sessions:resume-view-mode:v1';

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
  // Shorten the OS home dir to ~ without hardcoding a username (macOS
  // /Users/<user>, Linux /home/<user>) — matches App.tsx's cwdShort.
  return cwd.replace(/^\/(Users|home)\/[^/]+/, '~');
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

export function ResumeDialog({ onClose, onResumed, onStartNew, preferredProviderId }: Props): JSX.Element {
  const refresh = useSessions((s) => s.refresh);
  const openSessions = useSessions((s) => s.sessions);

  const [resumable, setResumable] = useState<ResumableSession[] | null>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<ViewMode>(readViewMode);
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<ResumableSession | null>(null);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    void fetchResumableSessions()
      .then((s) => {
        if (!alive) return;
        setResumable(s);
        if (preferredProviderId) {
          setSelected(s.find((session) => session.sessionId === preferredProviderId) ?? null);
        }
        setLoading(false);
      })
      .catch(() => { if (alive) { setResumable(null); setLoading(false); } });
    return () => { alive = false; };
  }, [preferredProviderId]);

  // Filter out sessions that are already open as sessionsd tabs — picking
  // one would spawn a second `claude --resume <id>` against the live
  // JSONL the open tab is writing to, fighting for the file.
  const openProviderIds = useMemo(() => {
    const ids = new Set<string>();
    for (const s of openSessions) {
      if (s.exited) continue;
      if (s.tool === 'claude-code') {
        const id = extractClaudeSessionId(s.args);
        if (id) ids.add(`claude:${id}`);
      } else if (s.tool === 'codex' && s.conversationId) {
        ids.add(`codex:${s.conversationId}`);
      }
    }
    return ids;
  }, [openSessions]);

  const available = useMemo(() => {
    if (!resumable) return null;
    const q = query.trim().toLowerCase();
    const list = resumable.filter((s) => !openProviderIds.has(`${s.tool}:${s.sessionId}`));
    if (!q) return list;
    return list.filter((s) => {
      const inMsg = s.firstUserMessage?.toLowerCase().includes(q) ?? false;
      const inFolder = shortFolder(s.cwd).toLowerCase().includes(q)
        || s.cwd.toLowerCase().includes(q);
      const inProvider = s.tool.includes(q) || (s.origin?.toLowerCase().includes(q) ?? false);
      return inMsg || inFolder || inProvider;
    });
  }, [resumable, openProviderIds, query]);

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

  const resume = async (): Promise<void> => {
    if (!selected) return;
    setBusy(true);
    setError(null);
    try {
      const result = await adoptConversation(selected.sessionId);
      await refresh();
      onResumed(result.laneId);
      onClose();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const totalAvailable = available?.length ?? 0;
  const openCount = resumable
    ? resumable.filter((s) => openProviderIds.has(`${s.tool}:${s.sessionId}`)).length
    : 0;

  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <div
        className="dialog dialog-wide resume-dialog"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label="Bring an existing conversation into Sessions"
      >
        <header className="resume-dialog-head">
          <div className="resume-dialog-title-row">
            <div>
              <span className="dialog-kicker">Same history · one active surface</span>
              <h2 className="resume-dialog-title">Resume a conversation</h2>
            </div>
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
          <div className="resume-safety-note">
            <strong>No transcript is copied.</strong>
            <span>Choose an idle Claude or Codex conversation. Sessions resumes its existing provider identity; do not keep writing to it in another app at the same time.</span>
          </div>
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
                    ? 'All resumable conversations are already open in Sessions.'
                    : 'No prior Claude or Codex conversations found on this machine.'}
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
                <ResumeCard key={`${s.tool}:${s.sessionId}`} session={s} selected={selected?.sessionId === s.sessionId && selected.tool === s.tool} onPick={() => setSelected(s)} disabled={busy} />
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
                        key={`${s.tool}:${s.sessionId}`}
                        session={s}
                        selected={selected?.sessionId === s.sessionId && selected.tool === s.tool}
                        onPick={() => setSelected(s)}
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
          <button type="button" className="btn btn-primary" onClick={() => void resume()} disabled={busy || !selected}>
            {busy ? 'Resuming…' : selected ? `Resume with ${selected.tool === 'codex' ? 'Codex' : 'Claude'}` : 'Choose a conversation'}
          </button>
        </footer>
      </div>
    </div>
  );
}

interface CardProps {
  session: ResumableSession;
  selected: boolean;
  onPick: () => void;
  disabled: boolean;
  // In grouped view the folder is already in the section header, so we
  // hide the per-card folder label and let the message column expand.
  hideFolder?: boolean;
}

function ResumeCard({ session, selected, onPick, disabled, hideFolder }: CardProps): JSX.Element {
  const msg = session.firstUserMessage?.trim() || '(no user input yet)';
  const size = session.sizeBytes < 100_000
    ? `${Math.round(session.sizeBytes / 1024)} KB`
    : `${(session.sizeBytes / 1024 / 1024).toFixed(1)} MB`;
  return (
    <button
      type="button"
      className={`resume-card${hideFolder ? ' resume-card-no-folder' : ''}${selected ? ' is-selected' : ''}`}
      onClick={onPick}
      disabled={disabled}
      aria-pressed={selected}
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
        <span className="resume-card-meta"><ProviderBadge provider={session.tool} compact /> {session.origin ?? ''}{hideFolder ? ` · ${relativeWhen(session.modifiedAt)} · ${size}` : ''}</span>
      </div>
    </button>
  );
}
