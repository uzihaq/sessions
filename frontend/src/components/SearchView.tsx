import { useEffect, useMemo, useState } from 'react';
import { searchServer, type SearchMatch } from '../api/prettyd';
import { useServers } from '../lib/servers';

interface Result extends SearchMatch { serverId: string; serverName: string }

export function SearchView({ onOpenSession }: { onOpenSession: (serverId: string, sessionId: string) => void }): JSX.Element {
  const servers = useServers((state) => state.servers);
  const [query, setQuery] = useState('');
  const [mode, setMode] = useState<'ranked' | 'exact' | 'regex'>('ranked');
  const [role, setRole] = useState('');
  const [tool, setTool] = useState('');
  const [results, setResults] = useState<Result[]>([]);
  const [errors, setErrors] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    const trimmed = query.trim();
    if (!trimmed) { setResults([]); setErrors([]); setLoading(false); return; }
    const controller = new AbortController();
    setLoading(true);
    const timer = window.setTimeout(() => {
      void Promise.all(servers.map(async (server) => {
        try {
          const response = await searchServer(server, { query: trimmed, mode, role: role || undefined, tool: tool || undefined, limit: 100 }, controller.signal);
          return { matches: response.matches.map((match) => ({ ...match, serverId: server.id, serverName: server.name })), error: null };
        } catch (reason) {
          return { matches: [] as Result[], error: `${server.name}: ${reason instanceof Error ? reason.message : 'unavailable'}` };
        }
      })).then((responses) => {
        if (controller.signal.aborted) return;
        setResults(responses.flatMap((response) => response.matches));
        setErrors(responses.flatMap((response) => response.error ? [response.error] : []));
        setLoading(false);
      });
    }, 220);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [query, mode, role, tool, servers]);

  const grouped = useMemo(() => {
    const map = new Map<string, Result[]>();
    for (const result of results) {
      const key = `${result.serverId}:${result.session_id}`;
      map.set(key, [...(map.get(key) ?? []), result]);
    }
    return [...map.entries()];
  }, [results]);

  return (
    <div className="search-view">
      <div className="search-shell">
        <header className="search-heading"><h1>Search</h1><p>Claude and Codex conversations across every configured machine.</p></header>
        <div className="search-query-row">
          <span aria-hidden>⌕</span>
          <input autoFocus value={query} onChange={(event) => setQuery(event.target.value)} placeholder={mode === 'ranked' ? 'Search ideas, errors, decisions…' : mode === 'regex' ? 'Enter a Go regular expression…' : 'Find exact text…'} />
          {loading ? <span className="search-spinner">indexing</span> : query ? <button type="button" onClick={() => setQuery('')}>×</button> : null}
        </div>
        <div className="search-filters">
          <div className="usage-segmented">
            {(['ranked', 'exact', 'regex'] as const).map((candidate) => <button type="button" key={candidate} className={mode === candidate ? 'is-active' : ''} onClick={() => setMode(candidate)}>{candidate === 'ranked' ? 'Smart' : candidate}</button>)}
          </div>
          <select aria-label="Role" value={role} onChange={(event) => setRole(event.target.value)}><option value="">Any role</option><option value="user">User</option><option value="assistant">Assistant</option></select>
          <select aria-label="Tool" value={tool} onChange={(event) => setTool(event.target.value)}><option value="">Any tool</option><option value="claude">Claude</option><option value="codex">Codex</option><option value="shell">Shell</option></select>
          <span className="search-result-count">{query.trim() ? `${results.length} matches in ${grouped.length} sessions` : `${servers.length} machines ready`}</span>
        </div>
        {errors.length > 0 ? <div className="search-errors">{errors.join(' · ')}</div> : null}
        {!query.trim() ? (
          <div className="search-welcome"><span>⌕</span><h2>Find the work you remember</h2><p>Smart search supports quoted phrases and AND, OR, and NOT. Exact and regex modes preserve the original search path.</p></div>
        ) : grouped.length === 0 && !loading ? <div className="usage-empty">No conversation matches.</div> : (
          <div className="search-results">
            {grouped.map(([key, matches]) => <SearchSessionGroup key={key} matches={matches} onOpen={() => onOpenSession(matches[0].serverId, matches[0].session_id)} />)}
          </div>
        )}
      </div>
    </div>
  );
}

function SearchSessionGroup({ matches, onOpen }: { matches: Result[]; onOpen: () => void }): JSX.Element {
  const first = matches[0];
  return (
    <section className="search-session-group">
      <header>
        <div><strong>{first.name || first.session_id.slice(0, 8)}</strong><span>{first.tool} · {first.serverName}</span></div>
        <button type="button" onClick={onOpen}>Open session ↗</button>
      </header>
      {matches.slice(0, 8).map((match, index) => (
        <button type="button" className="search-match" onClick={onOpen} key={`${match.timestamp ?? 'none'}:${index}`}>
          <span className={`search-role is-${match.role}`}>{match.role}</span>
          <span className="search-snippet">{match.snippet}</span>
          <time>{match.timestamp ? relativeDate(match.timestamp) : ''}</time>
        </button>
      ))}
      {matches.length > 8 ? <div className="search-more">+ {matches.length - 8} more matches</div> : null}
    </section>
  );
}

function relativeDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}
