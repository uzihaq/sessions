import { useState } from 'react';
import type { SessionInfo } from '../types';
import { getActiveServer } from '../lib/servers';
import { getTabLabel, sessionLabel } from '../lib/tabLabels';

interface Props {
  session: SessionInfo;
  allSessions: SessionInfo[];
  onEnd: (id: string) => Promise<void>;
}

export function SessionDetails({ session, allSessions, onEnd }: Props): JSX.Element {
  const [confirming, setConfirming] = useState(false);
  const parent = session.parentSessionId ? allSessions.find((item) => item.id === session.parentSessionId) : null;
  const children = allSessions.filter((item) => item.parentSessionId === session.id);
  const value = (content: string | number | null | undefined): string => content === null || content === undefined || content === '' ? '—' : String(content);
  return (
    <div className="session-details-view">
      <section className="details-grid">
        <DetailsCard title="Overview"><Row label="Session ID" value={session.id}/><Row label="Provider" value={session.tool}/><Row label="Profile" value={session.profile || 'Default'}/><Row label="Model" value={value(session.model)}/><Row label="Created" value={new Date(session.createdAt).toLocaleString()}/></DetailsCard>
        <DetailsCard title="Workspace"><Row label="Directory" value={session.cwd}/><Row label="Worktree" value={value(session.worktreePath)}/><Row label="Branch" value={value(session.branch)}/><Row label="Source repo" value={value(session.sourceRepo)}/></DetailsCard>
        <DetailsCard title="Runtime & recovery"><Row label="Machine" value={getActiveServer().name}/><Row label="PID" value={session.pid}/><Row label="Size" value={`${session.cols} × ${session.rows}`}/><Row label="Exit" value={session.exited ? `code ${value(session.exitCode)} · ${value(session.exitSignal)}` : 'Running'}/><Row label="Recovery" value={session.provenanceStatus || 'Tracked'}/></DetailsCard>
        <DetailsCard title="Relationships"><Row label="Parent" value={parent ? getTabLabel(parent.id) ?? sessionLabel(parent) : session.creatorKind ? `${session.creatorKind}: ${value(session.creatorId)}` : 'Top-level'}/><Row label="Children" value={`${children.filter((child) => !child.exited).length} active · ${children.filter((child) => child.exited).length} finished`}/><Row label="Root creator" value={session.rootCreatorKind ? `${session.rootCreatorKind}: ${value(session.rootCreatorId)}` : 'This app'}/><Row label="Ledger" value={session.provenanceStatus || 'Verified'}/></DetailsCard>
        <DetailsCard title="Usage"><p className="details-note">Turn-level usage is shown in Conversation. Full per-session cost attribution is available in Usage.</p><span className="coming-soon-pill">Richer budgets · Coming soon</span></DetailsCard>
        <DetailsCard title="Environment"><Row label="Command" value={[session.cmd, ...session.args].join(' ')}/><Row label="Config home" value={value(session.configDir)}/><Row label="Idle action" value={value(session.onIdle)}/></DetailsCard>
      </section>
      <section className="danger-zone"><div><span>Danger zone</span><h2>End this runtime session</h2><p>Closing an open tab only changes your workspace. Ending here terminates the process.</p></div>{confirming ? <div className="danger-actions"><button type="button" className="btn btn-ghost" onClick={() => setConfirming(false)}>Cancel</button><button type="button" className="btn btn-danger" onClick={() => void onEnd(session.id)}>End now</button></div> : <button type="button" className="btn btn-danger" disabled={session.exited} onClick={() => setConfirming(true)}>{session.exited ? 'Already ended' : 'End session'}</button>}</section>
    </div>
  );
}

function DetailsCard({ title, children }: { title: string; children: React.ReactNode }): JSX.Element { return <article className="details-card"><h2>{title}</h2><div>{children}</div></article>; }
function Row({ label, value }: { label: string; value: string | number }): JSX.Element { return <div className="details-row"><span>{label}</span><strong title={String(value)}>{value}</strong></div>; }
