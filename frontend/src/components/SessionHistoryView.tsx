import { useEffect, useState } from 'react';
import { fetchServerHistoryTranscript, type HistoryTranscript } from '../api/sessionsd';
import { getActiveServer, useServers } from '../lib/servers';
import { sessionLabel, useTabLabel } from '../lib/tabLabels';
import { useSessions } from '../store/sessions';
import type { SessionInfo } from '../types';
import { ProviderBadge, normalizeProvider } from './ProviderBadge';
import { SessionDetails } from './SessionDetails';

interface Props {
  session: SessionInfo;
  onDelegate?: (sessionId: string) => void;
  onResume?: (session: SessionInfo) => void;
}

export function SessionHistoryView({ session, onDelegate, onResume }: Props): JSX.Element {
  const activeServerId = useServers((state) => state.activeId);
  const allSessions = useSessions((state) => state.sessions);
  const label = useTabLabel(session.id, session.cwd) ?? sessionLabel(session);
  const supportsConversation = session.tool !== 'terminal';
  const [mode, setMode] = useState<'conversation' | 'details'>(supportsConversation ? 'conversation' : 'details');
  const [transcript, setTranscript] = useState<HistoryTranscript | null>(null);
  const [loading, setLoading] = useState(supportsConversation);
  const [error, setError] = useState<string | null>(null);
  const displayParentID = session.displayParentSessionId !== undefined
    ? session.displayParentSessionId
    : session.parentSessionId;
  const parent = displayParentID ? allSessions.find((item) => item.id === displayParentID) : null;
  const children = allSessions.filter((item) => (
    item.displayParentSessionId !== undefined ? item.displayParentSessionId : item.parentSessionId
  ) === session.id);
  const provider = normalizeProvider(session.tool);
  const providerID = session.conversationId || session.claudeSessionId;

  useEffect(() => {
    if (!supportsConversation) return;
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    setTranscript(null);
    void fetchServerHistoryTranscript(getActiveServer(), session.id, controller.signal, { preview: true })
      .then((value) => {
        if (!controller.signal.aborted) setTranscript(value);
      })
      .catch((reason: unknown) => {
        if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : 'Could not load the conversation.');
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [activeServerId, session.id, supportsConversation]);

  return (
    <div className="session-view view-history">
      <header className="session-active-header">
        <div className="session-active-copy">
          <span className="session-parent-breadcrumb">{parent ? `${sessionLabel(parent)} / ${session.displayParentSessionId !== undefined ? 'grouped session' : 'child session'}` : 'Manager session'} · read-only history</span>
          <div className="session-active-title-row"><h1>{label}</h1><span className="session-live-pill">Finished</span></div>
          <div className="session-active-meta">
            {provider ? <ProviderBadge provider={provider} compact /> : <span className="provider-badge is-shell is-compact">⌘ Shell</span>}
            <span>{session.profile || 'Default profile'}</span><span>{getActiveServer().name}</span><span title={session.cwd}>{session.cwd}</span>
          </div>
        </div>
        <div className="session-active-actions">
          {children.length > 0 ? <span className="child-health">{children.filter((child) => !child.exited).length} active · {children.filter((child) => child.exited).length} finished</span> : null}
          {providerID ? <button type="button" className="btn btn-primary session-resume" onClick={() => onResume?.(session)}>↻ Resume</button> : null}
          <button type="button" className="btn btn-ghost session-delegate" onClick={() => onDelegate?.(session.id)}>↳ Delegate</button>
        </div>
      </header>
      <div className="session-toolbar">
        <div className="view-toggle" role="tablist" aria-label="history view mode">
          {supportsConversation ? <button type="button" className={`view-toggle-btn${mode === 'conversation' ? ' is-active' : ''}`} onClick={() => setMode('conversation')}>Conversation</button> : null}
          <button type="button" className={`view-toggle-btn${mode === 'details' ? ' is-active' : ''}`} onClick={() => setMode('details')}>Details</button>
        </div>
        <span className="status-dot status-closed" />
        <span className="status-text">ended · viewing does not resume or send anything</span>
      </div>
      <div className="session-history-body">
        {mode === 'details' ? (
          <SessionDetails session={session} allSessions={allSessions} onEnd={async () => undefined} />
        ) : (
          <div className="session-history-transcript">
            {loading ? <div className="usage-empty">Loading the conversation…</div> : null}
            {error ? <div className="search-errors">{error}</div> : null}
            {transcript?.truncated ? <div className="search-preview-notice">Showing {transcript.messages.length} recent messages from a bounded preview (up to 400).</div> : null}
            {transcript?.messages.map((message, index) => (
              <article className={`session-history-message is-${message.role}`} key={`${message.timestamp ?? 'none'}:${index}`}>
                {message.role === 'assistant' ? (
                  <header>
                    {provider ? <ProviderBadge provider={provider} compact /> : <span>Agent</span>}
                    <time>{message.timestamp ? formatDate(message.timestamp) : ''}</time>
                  </header>
                ) : null}
                <p>{message.text}</p>
                {message.role === 'user' ? <footer><span>You</span><time>{message.timestamp ? formatDate(message.timestamp) : ''}</time></footer> : null}
              </article>
            ))}
            {!loading && !error && transcript?.messages.length === 0 ? <div className="usage-empty">This session has no normalized conversation messages.</div> : null}
          </div>
        )}
      </div>
    </div>
  );
}

function formatDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}
