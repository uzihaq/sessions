import { useEffect, useMemo, useState, type CSSProperties } from 'react';
import {
  fetchRecap,
  generateRecap,
  updateRecapSettings,
  type RecapDay,
  type RecapProvider,
  type RecapSettings
} from '../api/sessionsd';
import { renderContent } from '../lib/contentRender';

function localDate(date = new Date()): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function shiftDate(value: string, days: number): string {
  const [year, month, day] = value.split('-').map(Number);
  return localDate(new Date(year!, month! - 1, day! + days));
}

function compactNumber(value: number): string {
  return new Intl.NumberFormat(undefined, { notation: value >= 10_000 ? 'compact' : 'standard', maximumFractionDigits: 1 }).format(value);
}

function dollars(value: number): string {
  return new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD', maximumFractionDigits: 2 }).format(value);
}

function totalTokens(day: RecapDay): number {
  const tokens = day.usage.tokens;
  return tokens.inputTokens + tokens.outputTokens + tokens.cacheCreationTokens + tokens.cacheReadTokens;
}

export function TodayView(): JSX.Element {
  const [date, setDate] = useState(localDate);
  const [day, setDay] = useState<RecapDay | null>(null);
  const [loading, setLoading] = useState(true);
  const [generating, setGenerating] = useState(false);
  const [savingSettings, setSavingSettings] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    void fetchRecap(date, controller.signal)
      .then(setDay)
      .catch((reason: unknown) => {
        if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : 'Could not load the day');
      })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [date]);

  const saveSettings = async (settings: RecapSettings): Promise<void> => {
    if (savingSettings) return;
    setSavingSettings(true);
    setError(null);
    try {
      const saved = await updateRecapSettings(settings);
      setDay((current) => current ? { ...current, settings: saved } : current);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not save recap settings');
    } finally {
      setSavingSettings(false);
    }
  };

  const generate = async (): Promise<void> => {
    if (!day || day.settings.provider === 'off' || generating) return;
    setGenerating(true);
    setError(null);
    try {
      setDay(await generateRecap(date, day.document !== null));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not generate the recap');
    } finally {
      setGenerating(false);
    }
  };

  const activityRoots = useMemo(() => {
    if (!day) return [];
    const ids = new Set(day.activities.map((activity) => activity.id));
    return day.activities.map((activity) => ({
      ...activity,
      depth: activity.creatorAncestry?.filter((id) => ids.has(id)).length ?? (activity.parentSessionId && ids.has(activity.parentSessionId) ? 1 : 0)
    }));
  }, [day]);

  return (
    <div className="today-view">
      <div className="today-shell">
        <header className="today-heading">
          <div>
            <span className="today-eyebrow">Private work journal</span>
            <h1>Today</h1>
            <p>Local facts need no model call. A written recap is optional and uses only a compact daily summary.</p>
          </div>
          <div className="today-date-control">
            <button type="button" onClick={() => setDate(shiftDate(date, -1))} aria-label="Previous day">←</button>
            <input type="date" value={date} max={localDate()} onChange={(event) => setDate(event.currentTarget.value)} />
            <button type="button" disabled={date >= localDate()} onClick={() => setDate(shiftDate(date, 1))} aria-label="Next day">→</button>
          </div>
        </header>

        {error ? <div className="today-error" role="alert">{error}</div> : null}
        {loading || !day ? <div className="today-loading">Assembling the local day…</div> : (
          <>
            <section className="today-kpis" aria-label="Daily totals">
              <TodayKPI label="Sessions" value={String(day.activities.length)} detail={`${day.activities.filter((activity) => activity.outcome === 'done').length} completed`} />
              <TodayKPI label="Tokens" value={compactNumber(totalTokens(day))} detail={`${compactNumber(day.usage.tokens.reasoningTokens)} reasoning`} />
              <TodayKPI
                label="Estimated cost"
                value={dollars(day.usage.costUSD)}
                detail={day.usage.missingPricingEntries > 0 ? `${day.usage.missingPricingEntries} unpriced events` : `${day.usage.entries} usage events`}
              />
              <TodayKPI label="Projects" value={String(new Set(day.activities.map((activity) => activity.sourceRepo || activity.cwd)).size)} detail={day.timezone} />
            </section>

            <section className="today-recap-card">
              <header>
                <div>
                  <span className="today-section-kicker">One compact model call</span>
                  <h2>Daily recap</h2>
                </div>
                <div className="today-recap-controls">
                  <select
                    value={day.settings.provider}
                    disabled={savingSettings || generating}
                    onChange={(event) => void saveSettings({ ...day.settings, provider: event.currentTarget.value as RecapProvider })}
                    aria-label="Daily recap provider"
                  >
                    <option value="off">Off</option>
                    <option value="codex">Codex · recommended</option>
                    <option value="claude">Claude</option>
                  </select>
                  <button type="button" className="btn today-generate" disabled={day.settings.provider === 'off' || generating || savingSettings} onClick={() => void generate()}>
                    {generating ? 'Writing…' : day.document ? 'Refresh recap' : 'Generate recap'}
                  </button>
                </div>
              </header>
              {day.settings.provider === 'off' ? (
                <div className="today-opt-in">
                  <strong>No model calls are enabled.</strong>
                  <p>The timeline and usage below are complete local facts. Turn on Codex when you want a written recap.</p>
                  <button type="button" className="btn" onClick={() => void saveSettings({ provider: 'codex' })}>Use Codex for recaps</button>
                </div>
              ) : day.document ? (
                <>
                  <div className="today-markdown" dangerouslySetInnerHTML={{ __html: renderContent(day.document.markdown) }} />
                  <footer>Generated {new Date(day.document.generatedAt).toLocaleString()} with {day.document.provider}. Final answer stored only on this Mac.</footer>
                </>
              ) : (
                <div className="today-opt-in">
                  <strong>Ready to write with {day.settings.provider === 'codex' ? 'Codex' : 'Claude'}.</strong>
                  <p>Sessions sends at most 32 KiB of compact metadata, final summaries, tags, and authoritative totals—not full transcripts. Your CLI chooses its default model.</p>
                </div>
              )}
            </section>

            <section className="today-activity-card">
              <header><div><span className="today-section-kicker">Local evidence</span><h2>What was worked on</h2></div><span>{day.activities.length} sessions and lanes</span></header>
              {activityRoots.length === 0 ? <div className="today-empty">No Sessions activity was recorded for this day.</div> : (
                <div className="today-timeline">
                  {activityRoots.map((activity) => (
                    <article className="today-activity" key={activity.id} style={{ '--activity-depth': Math.min(activity.depth, 3) } as CSSProperties}>
                      <span className={`today-outcome is-${activity.outcome}`} aria-label={activity.outcome} />
                      <div className="today-activity-main">
                        <header><strong>{activity.name}</strong><time>{new Date(activity.lastActivityAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</time></header>
                        {activity.summary || activity.description ? <p>{activity.summary || activity.description}</p> : null}
                        <div className="today-activity-meta">
                          <span>{activity.tool}</span>
                          <span>{activity.branch || activity.sourceRepo || activity.cwd.replace(/^\/Users\/[^/]+/, '~')}</span>
                          {activity.parentSessionId ? <span>child lane</span> : null}
                          {Object.entries(activity.tags ?? {}).map(([key, value]) => <span className="today-tag" key={key}>{key}={value}</span>)}
                        </div>
                      </div>
                    </article>
                  ))}
                </div>
              )}
            </section>
          </>
        )}
      </div>
    </div>
  );
}

function TodayKPI({ label, value, detail }: { label: string; value: string; detail: string }): JSX.Element {
  return <div className="today-kpi"><span>{label}</span><strong>{value}</strong><small>{detail}</small></div>;
}
