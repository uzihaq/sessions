import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  fetchServerHistoryTranscript,
  planSmartSearch,
  searchServer,
  type HistoryTranscript,
  type SearchMatch,
  type SmartSearchPlan
} from '../api/sessionsd';
import { useServers, type ServerConfig } from '../lib/servers';
import { isTauri } from '../lib/tauriBridge';
import { ProviderBadge, normalizeProvider, type Provider } from './ProviderBadge';

type SearchMode = 'ai' | 'ranked' | 'exact' | 'regex';
type Speaker = '' | 'user' | 'assistant';
type Tool = '' | Provider;

interface Result extends SearchMatch { serverId: string; serverName: string }
interface SelectedConversation {
  result: Result;
  transcript: HistoryTranscript | null;
  loading: boolean;
  error: string | null;
}

interface SavedSearchState {
  query: string;
  mode: SearchMode;
  speaker: Speaker;
  tool: Tool;
}

const SEARCH_STATE_KEY = 'sessions:search-state:v2';

function readSearchState(): SavedSearchState {
  try {
    const value = JSON.parse(window.localStorage.getItem(SEARCH_STATE_KEY) ?? '{}') as Partial<SavedSearchState>;
    return {
      query: typeof value.query === 'string' ? value.query : '',
      mode: value.mode === 'ai' || value.mode === 'ranked' || value.mode === 'exact' || value.mode === 'regex' ? value.mode : 'ranked',
      speaker: value.speaker === 'user' || value.speaker === 'assistant' ? value.speaker : '',
      tool: value.tool === 'claude' || value.tool === 'codex' ? value.tool : ''
    };
  } catch {
    return { query: '', mode: 'ranked', speaker: '', tool: '' };
  }
}

export function SearchView(): JSX.Element {
  const initial = useMemo(readSearchState, []);
  const nativeClient = isTauri();
  const servers = useServers((state) => state.servers);
  const activeServerId = useServers((state) => state.activeId);
  const [query, setQuery] = useState(initial.query);
  const [mode, setMode] = useState<SearchMode>(nativeClient ? initial.mode : (initial.mode === 'ai' ? 'ranked' : initial.mode));
  const [speaker, setSpeaker] = useState<Speaker>(initial.speaker);
  const [tool, setTool] = useState<Tool>(initial.tool);
  const [plan, setPlan] = useState<SmartSearchPlan | null>(null);
  const [planning, setPlanning] = useState(false);
  const [results, setResults] = useState<Result[]>([]);
  const [errors, setErrors] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<SelectedConversation | null>(null);
  const planGeneration = useRef(0);
  const planAbort = useRef<AbortController | null>(null);
  const previewAbort = useRef<AbortController | null>(null);
  const previousActiveServerId = useRef(activeServerId);

  useEffect(() => {
    try { window.localStorage.setItem(SEARCH_STATE_KEY, JSON.stringify({ query, mode, speaker, tool })); }
    catch { /* storage is optional */ }
  }, [query, mode, speaker, tool]);

  useEffect(() => () => {
    planAbort.current?.abort();
    previewAbort.current?.abort();
  }, []);

  useEffect(() => {
    if (previousActiveServerId.current === activeServerId) return;
    previousActiveServerId.current = activeServerId;
    planGeneration.current += 1;
    planAbort.current?.abort();
    setPlanning(false);
    setPlan(null);
  }, [activeServerId]);

  const effectiveQuery = mode === 'ai' ? (plan?.query.trim() ?? '') : query.trim();
  useEffect(() => {
    if (!effectiveQuery) { setResults([]); setErrors([]); setLoading(false); return; }
    const controller = new AbortController();
    setLoading(true);
    const timer = window.setTimeout(() => {
      void Promise.all(servers.map(async (server) => {
        try {
          const response = await searchServer(server, {
            query: effectiveQuery,
            mode: mode === 'regex' ? 'regex' : mode === 'exact' ? 'exact' : 'ranked',
            role: speaker || undefined,
            tool: tool || undefined,
            limit: 100
          }, controller.signal);
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
    }, mode === 'ai' ? 0 : 220);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [effectiveQuery, mode, speaker, tool, servers]);

  const grouped = useMemo(() => {
    const map = new Map<string, Result[]>();
    for (const result of results) {
      const key = `${result.serverId}:${result.session_id}`;
      map.set(key, [...(map.get(key) ?? []), result]);
    }
    return [...map.entries()];
  }, [results]);

  const updateQuery = (value: string): void => {
    setQuery(value);
    if (mode === 'ai') {
      planGeneration.current += 1;
      planAbort.current?.abort();
      setPlanning(false);
      setPlan(null);
    }
  };

  const selectMode = (next: SearchMode): void => {
    planGeneration.current += 1;
    planAbort.current?.abort();
    setPlanning(false);
    setMode(next);
    setPlan(null);
    setErrors([]);
  };

  const runAISearch = async (): Promise<void> => {
    const naturalQuery = query.trim();
    if (!naturalQuery || planning) return;
    const generation = planGeneration.current + 1;
    planGeneration.current = generation;
    planAbort.current?.abort();
    const controller = new AbortController();
    planAbort.current = controller;
    setPlanning(true);
    setPlan(null);
    setResults([]);
    setErrors([]);
    try {
      const nextPlan = await planSmartSearch(naturalQuery, controller.signal);
      if (planGeneration.current === generation) setPlan(nextPlan);
    } catch (reason) {
      if (planGeneration.current === generation && !controller.signal.aborted) {
        setErrors([reason instanceof Error ? reason.message : 'AI search planning failed']);
      }
    } finally {
      if (planGeneration.current === generation) setPlanning(false);
    }
  };

  const viewConversation = (result: Result): void => {
    const server = servers.find((candidate) => candidate.id === result.serverId);
    if (!server) {
      setErrors([`The ${result.serverName} connection is no longer configured.`]);
      return;
    }
    previewAbort.current?.abort();
    const controller = new AbortController();
    previewAbort.current = controller;
    setSelected({ result, transcript: null, loading: true, error: null });
    void fetchServerHistoryTranscript(server, result.session_id, controller.signal)
      .then((transcript) => setSelected((current) => current?.result === result ? { ...current, transcript, loading: false } : current))
      .catch((reason: unknown) => setSelected((current) => current?.result === result ? {
        ...current,
        loading: false,
        error: reason instanceof Error ? reason.message : 'Could not load the conversation'
      } : current));
  };

  if (selected) {
    return <ConversationPreview selected={selected} server={servers.find((candidate) => candidate.id === selected.result.serverId)} onBack={() => { previewAbort.current?.abort(); setSelected(null); }} />;
  }

  const hasSearch = mode === 'ai' ? Boolean(plan) : Boolean(query.trim());
  const resultSummary = hasSearch
    ? `${results.length} matches in ${grouped.length} sessions`
    : `${servers.length} machines ready`;

  return (
    <div className="search-view">
      <div className="search-shell">
        <header className="search-heading"><h1>Search</h1><p>Claude and Codex conversations across every configured machine.</p></header>
        <form className="search-query-row" onSubmit={(event) => { event.preventDefault(); if (mode === 'ai') void runAISearch(); }}>
          <span aria-hidden>⌕</span>
          <input
            autoFocus
            value={query}
            onChange={(event) => updateQuery(event.target.value)}
            placeholder={mode === 'ai' ? 'The session where I talked about signing the Mac app…' : mode === 'regex' ? 'Enter a Go regular expression…' : 'Search ideas, errors, decisions…'}
          />
          {mode === 'ai' ? <button type="submit" className="search-ai-submit" disabled={!query.trim() || planning}>{planning ? 'Thinking…' : 'Search with AI'}</button> : null}
          {loading ? <span className="search-spinner">searching</span> : query ? <button type="button" aria-label="Clear search" onClick={() => updateQuery('')}>×</button> : null}
        </form>
        <div className="search-mode-row">
          <div className="usage-segmented" role="tablist" aria-label="Search method">
            {(nativeClient ? ['ai', 'ranked', 'exact', 'regex'] as const : ['ranked', 'exact', 'regex'] as const).map((candidate) => (
              <button type="button" key={candidate} className={mode === candidate ? 'is-active' : ''} onClick={() => selectMode(candidate)}>
                {candidate === 'ai' ? 'AI' : candidate === 'ranked' ? 'Ranked' : candidate}
              </button>
            ))}
          </div>
          {plan ? <span className="search-plan"><ProviderBadge provider={plan.provider} compact /> planned <code>{plan.query}</code></span> : null}
          <span className="search-result-count">{resultSummary}</span>
        </div>
        <section className="search-filter-panel" aria-label="Search filters">
          <strong>Filters</strong>
          <FilterGroup label="Provider">
            <FilterButton active={tool === ''} onClick={() => setTool('')}>All</FilterButton>
            <FilterButton active={tool === 'claude'} onClick={() => setTool('claude')}><ProviderBadge provider="claude" compact /></FilterButton>
            <FilterButton active={tool === 'codex'} onClick={() => setTool('codex')}><ProviderBadge provider="codex" compact /></FilterButton>
          </FilterGroup>
          <FilterGroup label="Speaker">
            <FilterButton active={speaker === ''} onClick={() => setSpeaker('')}>All</FilterButton>
            <FilterButton active={speaker === 'user'} onClick={() => setSpeaker('user')}>User</FilterButton>
            <FilterButton active={speaker === 'assistant'} onClick={() => setSpeaker('assistant')}>Agent</FilterButton>
          </FilterGroup>
        </section>
        {errors.length > 0 ? <div className="search-errors">{errors.join(' · ')}</div> : null}
        {!hasSearch ? (
          <div className="search-welcome"><span>⌕</span><h2>Find the work you remember</h2><p>AI sends only your search request to the Codex or Claude CLI selected in Settings, then applies the generated query to the local index. No transcripts leave Sessions.</p></div>
        ) : grouped.length === 0 && !loading ? <div className="usage-empty">No conversation matches.</div> : (
          <div className="search-results">
            {grouped.map(([key, matches]) => <SearchSessionGroup key={key} matches={matches} onView={() => viewConversation(matches[0])} />)}
          </div>
        )}
      </div>
    </div>
  );
}

function FilterGroup({ label, children }: { label: string; children: ReactNode }): JSX.Element {
  return <div className="search-filter-group"><span>{label}</span><div>{children}</div></div>;
}

function FilterButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: ReactNode }): JSX.Element {
  return <button type="button" className={active ? 'is-active' : ''} onClick={onClick}>{children}</button>;
}

function SearchSessionGroup({ matches, onView }: { matches: Result[]; onView: () => void }): JSX.Element {
  const first = matches[0];
  const provider = normalizeProvider(first.tool);
  return (
    <section className={`search-session-group${provider ? ` is-${provider}` : ''}`}>
      <header>
        <div>
          <strong>{first.name || first.session_id.slice(0, 8)}</strong>
          <span className="search-session-meta">{provider ? <ProviderBadge provider={provider} compact /> : first.tool} <span>· {first.serverName}</span></span>
        </div>
        <button type="button" onClick={onView}>View session →</button>
      </header>
      {matches.slice(0, 8).map((match, index) => (
        <button type="button" className="search-match" onClick={onView} key={`${match.timestamp ?? 'none'}:${index}`}>
          {match.role === 'user'
            ? <span className="search-role is-user">User</span>
            : provider ? <ProviderBadge provider={provider} compact /> : <span className="search-role">Agent</span>}
          <span className="search-snippet">{match.snippet}</span>
          <time>{match.timestamp ? relativeDate(match.timestamp) : ''}</time>
        </button>
      ))}
      {matches.length > 8 ? <div className="search-more">+ {matches.length - 8} more matches</div> : null}
    </section>
  );
}

function ConversationPreview({
  selected,
  server,
  onBack
}: {
  selected: SelectedConversation;
  server: ServerConfig | undefined;
  onBack: () => void;
}): JSX.Element {
  const provider = normalizeProvider(selected.transcript?.session.tool ?? selected.result.tool);
  return (
    <div className="search-view search-conversation-view">
      <div className="search-shell">
        <button type="button" className="search-back" onClick={onBack}>← Back to search</button>
        <header className="search-conversation-heading">
          <div>
            <span className="search-conversation-kicker">Read-only history</span>
            <h1>{selected.transcript?.session.name || selected.result.name || selected.result.session_id.slice(0, 8)}</h1>
            <p>{provider ? <ProviderBadge provider={provider} /> : null}<span>{server?.name ?? selected.result.serverName}</span>{selected.transcript?.session.cwd ? <code>{compactPath(selected.transcript.session.cwd)}</code> : null}</p>
          </div>
          <span>Viewing does not resume or send anything.</span>
        </header>
        {selected.error ? <div className="search-errors">{selected.error}</div> : null}
        {selected.loading ? <div className="usage-empty">Loading the conversation…</div> : null}
        {selected.transcript ? (
          <div className="search-transcript">
            {selected.transcript.truncated ? <div className="search-preview-notice">Showing {selected.transcript.messages.length} recent messages from a bounded preview (up to 400).</div> : null}
            {selected.transcript.messages.map((message, index) => (
              <article className={`search-transcript-message is-${message.role}`} key={`${message.timestamp ?? 'none'}:${index}`}>
                <header>
                  {message.role === 'user' ? <span className="search-role is-user">User</span> : provider ? <ProviderBadge provider={provider} compact /> : <span className="search-role">Agent</span>}
                  <time>{message.timestamp ? relativeDate(message.timestamp) : ''}</time>
                </header>
                <p>{message.text}</p>
              </article>
            ))}
            {selected.transcript.messages.length === 0 ? <div className="usage-empty">This session has no normalized conversation messages.</div> : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function compactPath(value: string): string {
  return value.replace(/^\/(Users|home)\/[^/]+/, '~');
}

function relativeDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}
