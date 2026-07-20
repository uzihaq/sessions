import { useEffect, useMemo, useState } from 'react';
import { fetchUsage, type UsageReport, type UsageRow, type UsageTokens } from '../api/prettyd';
import { useServers } from '../lib/servers';
import { useSessions } from '../store/sessions';
import { TagEditor } from './TagEditor';

type Group = UsageReport['group'];
type Mode = UsageReport['mode'];

const GROUPS: Array<{ id: Group; label: string }> = [
  { id: 'daily', label: 'Daily' },
  { id: 'weekly', label: 'Weekly' },
  { id: 'monthly', label: 'Monthly' },
  { id: 'session', label: 'Sessions' },
  { id: 'tag', label: 'Tags' }
];

function totalTokens(tokens: UsageTokens): number {
  return tokens.inputTokens + tokens.outputTokens + tokens.cacheCreationTokens + tokens.cacheReadTokens;
}

function compactNumber(value: number): string {
  return new Intl.NumberFormat(undefined, { notation: value >= 10_000 ? 'compact' : 'standard', maximumFractionDigits: 1 }).format(value);
}

function dollars(value: number): string {
  return new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD', minimumFractionDigits: value < 1 ? 3 : 2, maximumFractionDigits: value < 1 ? 3 : 2 }).format(value);
}

export function UsageDashboard(): JSX.Element {
  const activeServerId = useServers((state) => state.activeId);
  const [group, setGroup] = useState<Group>('daily');
  const [mode, setMode] = useState<Mode>('auto');
  const [provider, setProvider] = useState<'all' | 'claude' | 'codex'>('all');
  const [dimension, setDimension] = useState('product');
  const [report, setReport] = useState<UsageReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshToken, setRefreshToken] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    const timer = window.setTimeout(() => {
      void fetchUsage({
        group,
        mode,
        provider: provider === 'all' ? undefined : provider,
        dimension: group === 'tag' ? dimension.trim().toLowerCase() || 'product' : undefined
      }, controller.signal)
        .then((value) => setReport(value))
        .catch((reason: unknown) => {
          if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : 'Usage report failed');
        })
        .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    }, group === 'tag' ? 250 : 0);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [activeServerId, group, mode, provider, dimension, refreshToken]);

  const maxTokens = useMemo(() => Math.max(1, ...(report?.rows.map((row) => totalTokens(row.tokens)) ?? [])), [report]);

  return (
    <div className="usage-view">
      <div className="usage-shell">
        <header className="usage-heading">
          <div>
            <h1>Usage</h1>
            <p>Local Claude and Codex activity, indexed on this machine.</p>
          </div>
          <button type="button" className="btn btn-ghost" disabled={loading} onClick={() => setRefreshToken((value) => value + 1)}>
            {loading ? 'Indexing…' : 'Refresh'}
          </button>
        </header>

        <div className="usage-controls">
          <div className="usage-segmented" role="tablist" aria-label="Usage grouping">
            {GROUPS.map((item) => (
              <button key={item.id} type="button" className={group === item.id ? 'is-active' : ''} onClick={() => setGroup(item.id)}>{item.label}</button>
            ))}
          </div>
          <label>Provider
            <select value={provider} onChange={(event) => setProvider(event.target.value as typeof provider)}>
              <option value="all">All</option><option value="claude">Claude</option><option value="codex">Codex</option>
            </select>
          </label>
          <label>Cost
            <select value={mode} onChange={(event) => setMode(event.target.value as Mode)}>
              <option value="auto">Auto</option><option value="calculate">Calculate</option><option value="display">Recorded</option>
            </select>
          </label>
          {group === 'tag' ? (
            <label>Tag key<input value={dimension} onChange={(event) => setDimension(event.target.value)} placeholder="product" /></label>
          ) : null}
        </div>

        {error ? <div className="usage-error">{error}</div> : null}
        {report ? (
          <>
            <section className="usage-kpis" aria-label="Usage totals">
              <UsageKPI label="Total tokens" value={compactNumber(totalTokens(report.totals.tokens))} detail={`${compactNumber(report.totals.entries)} billable events`} />
              <UsageKPI label="Estimated cost" value={dollars(report.totals.costUSD)} detail={mode === 'auto' ? 'recorded where available' : mode === 'calculate' ? 'pinned token pricing' : 'recorded costs only'} />
              <UsageKPI label="Cache reads" value={compactNumber(report.totals.tokens.cacheReadTokens)} detail={`${percent(report.totals.tokens.cacheReadTokens, totalTokens(report.totals.tokens))}% of tokens`} />
              <UsageKPI label="Sources" value={compactNumber(report.scan.filesSeen)} detail={`${report.scan.filesRead} changed this refresh`} />
            </section>

            <section className="usage-panel">
              <header><h2>{GROUPS.find((item) => item.id === group)?.label} breakdown</h2><span>{report.rows.length} rows</span></header>
              {report.rows.length === 0 ? <div className="usage-empty">No local usage matched these filters.</div> : (
                <div className="usage-row-list">
                  {report.rows.map((row) => (
                    <UsageReportRow key={row.key} row={row} maxTokens={maxTokens} editable={group === 'session'} onTagsSaved={() => setRefreshToken((value) => value + 1)} />
                  ))}
                </div>
              )}
            </section>

            <footer className="usage-provenance">
              <span>Costs are estimates.</span> {report.pricing.note}{' '}
              <a href={report.pricing.url} target="_blank" rel="noreferrer">Pricing revision {report.pricing.revision}</a>
              {report.totals.missingPricingEntries > 0 ? <strong>{report.totals.missingPricingEntries} entries are visibly unpriced.</strong> : null}
            </footer>
          </>
        ) : loading ? <div className="usage-empty">Building the local usage index…</div> : null}
      </div>
    </div>
  );
}

function UsageKPI({ label, value, detail }: { label: string; value: string; detail: string }): JSX.Element {
  return <div className="usage-kpi"><span>{label}</span><strong>{value}</strong><small>{detail}</small></div>;
}

function UsageReportRow({ row, maxTokens, editable, onTagsSaved }: { row: UsageRow; maxTokens: number; editable: boolean; onTagsSaved: () => void }): JSX.Element {
  const updateTags = useSessions((state) => state.updateTags);
  const [editing, setEditing] = useState(false);
  const [tags, setTags] = useState<Record<string, string>>(row.tags ?? {});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const tokens = totalTokens(row.tokens);
  return (
    <div className="usage-row">
      <div className="usage-row-main">
        <div className="usage-row-title">
          <strong>{row.key}</strong>
          {row.provider ? <span className={`usage-provider is-${row.provider}`}>{row.provider}</span> : null}
          {row.missingPricingEntries > 0 ? <span className="usage-unpriced" title="No matching model price in the pinned snapshot">unpriced</span> : null}
          {Object.entries(row.tags ?? {}).slice(0, 3).map(([key, value]) => <span className="usage-mini-tag" key={key}>{key}={value}</span>)}
        </div>
        <div className="usage-bar"><span style={{ width: `${Math.max(1.5, (tokens / maxTokens) * 100)}%` }} /></div>
        <div className="usage-row-meta">{row.models.join(' · ') || 'Unknown model'} · {compactNumber(row.entries)} events</div>
      </div>
      <div className="usage-row-number"><strong>{compactNumber(tokens)}</strong><span>tokens</span></div>
      <div className="usage-row-number"><strong>{dollars(row.costUSD)}</strong><span>cost</span></div>
      {editable && row.sessionId ? <button type="button" className="usage-edit-tags" onClick={() => setEditing((value) => !value)}>{editing ? 'Close' : 'Tags'}</button> : null}
      {editing && row.sessionId ? (
        <div className="usage-tag-edit">
          <TagEditor value={tags} onChange={setTags} disabled={saving} />
          {error ? <span className="tag-editor-error">{error}</span> : null}
          <div className="usage-tag-actions">
            <button type="button" className="btn btn-primary" disabled={saving} onClick={() => {
              setSaving(true); setError(null);
              void updateTags(row.sessionId!, tags).then(() => { setEditing(false); onTagsSaved(); }).catch((reason: unknown) => setError(reason instanceof Error ? reason.message : 'Could not save tags')).finally(() => setSaving(false));
            }}>{saving ? 'Saving…' : 'Save tags'}</button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function percent(part: number, total: number): number { return total > 0 ? Math.round((part / total) * 100) : 0; }
