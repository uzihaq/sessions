import { useEffect, useMemo, useState } from 'react';
import type { SessionInfo } from '../types';
import { getTabLabel, sessionLabel } from '../lib/tabLabels';
import { ProviderBadge, normalizeProvider } from './ProviderBadge';

type PrimaryFilter = 'all' | 'needs' | 'running' | 'finished' | 'failed';
type ProviderFilter = 'all' | 'claude' | 'codex' | 'shell';
type DateFilter = 'all' | 'today' | 'week';

const PIN_KEY = 'sessions:pinned-managers:v1';

function readPins(): string[] {
  try {
    const value = JSON.parse(window.localStorage.getItem(PIN_KEY) ?? '[]');
    return Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string').slice(0, 5) : [];
  } catch { return []; }
}

function lastActivity(session: SessionInfo): number {
  return Math.max(session.lastDataAt || 0, session.exitedAt ?? 0, session.createdAt || 0);
}

function relativeTime(at: number): string {
  const delta = Math.max(0, Date.now() - at);
  if (delta < 60_000) return 'now';
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)}m`;
  if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)}h`;
  if (delta < 604_800_000) return `${Math.floor(delta / 86_400_000)}d`;
  return new Date(at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function projectName(session: SessionInfo): string {
  const tagged = session.tags?.project ?? session.tags?.product;
  if (tagged) return tagged;
  const path = session.sourceRepo || session.cwd;
  return path.split('/').filter(Boolean).pop() ?? path;
}

function isFailed(session: SessionInfo): boolean {
  return (session.exited && ((session.exitCode ?? 0) !== 0 || !!session.exitSignal))
    || session.provenanceStatus === 'lost'
    || session.provenanceStatus === 'invalid';
}

function isFinished(session: SessionInfo): boolean { return session.exited && !isFailed(session); }
function needsYou(session: SessionInfo): boolean {
  return !session.exited && !session.working && session.lastUserMessageAt !== null;
}

interface Props {
  sessions: SessionInfo[];
  activeId: string | null;
  machine: string;
  onOpen: (id: string) => void;
  onNew: () => void;
}

export function SessionNavigator({ sessions, activeId, machine, onOpen, onNew }: Props): JSX.Element {
  const [primary, setPrimary] = useState<PrimaryFilter>('all');
  const [provider, setProvider] = useState<ProviderFilter>('all');
  const [project, setProject] = useState('all');
  const [date, setDate] = useState<DateFilter>('all');
  const [query, setQuery] = useState('');
  const [pins, setPins] = useState<string[]>(readPins);
  const [expandedCompleted, setExpandedCompleted] = useState<Set<string>>(new Set());

  const sessionIds = useMemo(() => new Set(sessions.map((session) => session.id)), [sessions]);
  useEffect(() => {
    setPins((current) => {
      const next = current.filter((id) => sessionIds.has(id)).slice(0, 5);
      if (next.length === current.length && next.every((id, index) => id === current[index])) return current;
      try { window.localStorage.setItem(PIN_KEY, JSON.stringify(next)); } catch { /* non-fatal */ }
      return next;
    });
  }, [sessionIds]);
  const children = useMemo(() => {
    const byParent = new Map<string, SessionInfo[]>();
    for (const session of sessions) {
      if (!session.parentSessionId || !sessionIds.has(session.parentSessionId)) continue;
      const list = byParent.get(session.parentSessionId) ?? [];
      list.push(session);
      byParent.set(session.parentSessionId, list);
    }
    for (const list of byParent.values()) list.sort((a, b) => lastActivity(b) - lastActivity(a));
    return byParent;
  }, [sessions, sessionIds]);

  const roots = useMemo(() => sessions
    .filter((session) => !session.parentSessionId || !sessionIds.has(session.parentSessionId))
    .sort((a, b) => {
      const ap = pins.indexOf(a.id); const bp = pins.indexOf(b.id);
      if (ap >= 0 || bp >= 0) return ap < 0 ? 1 : bp < 0 ? -1 : ap - bp;
      return lastActivity(b) - lastActivity(a);
    }), [sessions, sessionIds, pins]);

  const projects = useMemo(() => [...new Set(sessions.map(projectName).filter(Boolean))].sort(), [sessions]);
  const counts = useMemo(() => ({
    needs: sessions.filter(needsYou).length,
    running: sessions.filter((session) => session.working && !session.exited).length,
    finished: sessions.filter(isFinished).length,
    failed: sessions.filter(isFailed).length
  }), [sessions]);

  const matches = (session: SessionInfo): boolean => {
    if (primary === 'needs' && !needsYou(session)) return false;
    if (primary === 'running' && (!session.working || session.exited)) return false;
    if (primary === 'finished' && !isFinished(session)) return false;
    if (primary === 'failed' && !isFailed(session)) return false;
    const normalized = normalizeProvider(session.tool);
    if (provider !== 'all' && (provider === 'shell' ? session.tool !== 'terminal' : normalized !== provider)) return false;
    if (project !== 'all' && projectName(session) !== project) return false;
    const age = Date.now() - lastActivity(session);
    if (date === 'today' && age > 86_400_000) return false;
    if (date === 'week' && age > 7 * 86_400_000) return false;
    const needle = query.trim().toLowerCase();
    if (needle) {
      const haystack = `${getTabLabel(session.id) ?? sessionLabel(session)} ${session.cwd} ${Object.values(session.tags ?? {}).join(' ')}`.toLowerCase();
      if (!haystack.includes(needle)) return false;
    }
    return true;
  };

  const treeMatches = (session: SessionInfo): boolean => matches(session) || (children.get(session.id) ?? []).some(treeMatches);
  const hasLiveDescendant = (session: SessionInfo): boolean => (children.get(session.id) ?? [])
    .some((child) => !child.exited || hasLiveDescendant(child));
  const togglePin = (id: string): void => {
    setPins((current) => {
      if (!current.includes(id) && current.length >= 5) return current;
      const next = current.includes(id) ? current.filter((item) => item !== id) : [...current, id];
      try { window.localStorage.setItem(PIN_KEY, JSON.stringify(next)); } catch { /* non-fatal */ }
      return next;
    });
  };
  const toggleCompleted = (id: string): void => setExpandedCompleted((current) => {
    const next = new Set(current);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  const renderNode = (session: SessionInfo, depth: number): JSX.Element | null => {
    if (!treeMatches(session)) return null;
    const nested = children.get(session.id) ?? [];
    // Never collapse the only path to live work. A finished intermediary can
    // still own a running grandchild, so it remains visible until its entire
    // subtree is finished.
    const completed = nested.filter((child) => isFinished(child) && !hasLiveDescendant(child));
    const completedIds = new Set(completed.map((child) => child.id));
    const visible = nested.filter((child) => !completedIds.has(child.id) || expandedCompleted.has(session.id));
    const providerName = normalizeProvider(session.tool);
    const status = isFailed(session) ? 'failed' : session.working ? 'running' : needsYou(session) ? 'needs' : session.exited ? 'finished' : 'idle';
    return (
      <div className="session-tree-node" key={session.id}>
        <button
          type="button"
          className={`session-nav-row is-${status}${session.id === activeId ? ' is-active' : ''}`}
          data-session-id={session.id}
          style={{ '--tree-depth': depth } as React.CSSProperties}
          onClick={() => onOpen(session.id)}
        >
          <span className="session-nav-branch" aria-hidden>{depth > 0 ? '└' : ''}</span>
          <span className={`session-nav-status is-${status}`} aria-hidden />
          <span className="session-nav-copy">
            <span className="session-nav-title">{getTabLabel(session.id) ?? sessionLabel(session)}</span>
            <span className="session-nav-meta">
              {providerName ? <ProviderBadge provider={providerName} compact /> : <span className="provider-badge is-shell is-compact">⌘ Shell</span>}
              <span>{machine}</span><span>{relativeTime(lastActivity(session))}</span>
            </span>
          </span>
          {depth === 0 ? (
            <span
              role="button"
              tabIndex={0}
              className={`manager-pin${pins.includes(session.id) ? ' is-pinned' : ''}`}
              title={pins.includes(session.id) ? 'Unpin manager' : pins.length >= 5 ? 'Five managers already pinned' : 'Pin manager'}
              onClick={(event) => { event.stopPropagation(); if (pins.includes(session.id) || pins.length < 5) togglePin(session.id); }}
              onKeyDown={(event) => { if (event.key === 'Enter') { event.stopPropagation(); togglePin(session.id); } }}
            >{pins.includes(session.id) ? '●' : '○'}</span>
          ) : null}
        </button>
        {visible.map((child) => renderNode(child, depth + 1))}
        {completed.length > 0 ? (
          <button type="button" className="completed-children" style={{ '--tree-depth': depth + 1 } as React.CSSProperties} onClick={() => toggleCompleted(session.id)}>
            {expandedCompleted.has(session.id) ? 'Hide completed' : `${completed.length} completed`}
          </button>
        ) : null}
      </div>
    );
  };

  return (
    <aside className="session-navigator">
      <header className="session-navigator-head">
        <div><span>Operations inbox</span><strong>Sessions</strong></div>
        <button type="button" onClick={onNew} aria-label="New session">＋</button>
      </header>
      <div className="session-nav-search"><span aria-hidden>⌕</span><input value={query} onChange={(event) => setQuery(event.currentTarget.value)} placeholder="Filter sessions" /></div>
      <div className="session-filter-row" role="toolbar" aria-label="Session status filters">
        <FilterButton label="All" active={primary === 'all'} onClick={() => setPrimary('all')} />
        <FilterButton label={`Needs you${counts.needs ? ` ${counts.needs}` : ''}`} active={primary === 'needs'} onClick={() => setPrimary('needs')} />
        <FilterButton label="Running" active={primary === 'running'} onClick={() => setPrimary('running')} />
        <FilterButton label="Finished" active={primary === 'finished'} onClick={() => setPrimary('finished')} />
        <FilterButton label="Failed" active={primary === 'failed'} onClick={() => setPrimary('failed')} />
        <details className="session-more-filters">
          <summary aria-label="More filters">⋯</summary>
          <div className="session-filter-popover">
            <label>Provider<select value={provider} onChange={(event) => setProvider(event.currentTarget.value as ProviderFilter)}><option value="all">All providers</option><option value="claude">Claude</option><option value="codex">Codex</option><option value="shell">Shell</option></select></label>
            <label>Machine<select disabled><option>{machine}</option></select></label>
            <label>Project<select value={project} onChange={(event) => setProject(event.currentTarget.value)}><option value="all">All projects</option>{projects.map((item) => <option key={item}>{item}</option>)}</select></label>
            <label>Date<select value={date} onChange={(event) => setDate(event.currentTarget.value as DateFilter)}><option value="all">Any time</option><option value="today">Today</option><option value="week">Past 7 days</option></select></label>
          </div>
        </details>
      </div>
      <div className="session-tree" role="tree">
        {pins.some((id) => roots.some((root) => root.id === id)) ? <div className="session-tree-label">Pinned managers <span>{Math.min(pins.length, 5)}/5</span></div> : null}
        {roots.map((root) => renderNode(root, 0))}
        {roots.length === 0 ? <div className="session-tree-empty">No sessions on this machine.</div> : null}
      </div>
    </aside>
  );
}

function FilterButton({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }): JSX.Element {
  return <button type="button" className={active ? 'is-active' : ''} onClick={onClick}>{label}</button>;
}
