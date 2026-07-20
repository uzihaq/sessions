import { useEffect, useMemo, useState } from 'react';
import { useSessions } from '../store/sessions';
import { DirectoryBrowser } from './DirectoryBrowser';
import { fetchResumableSessions, type ResumableSession } from '../api/prettyd';
import { readNewSessionDefaults, type NewSessionTool } from '../lib/newSessionDefaults';
import { randomUUID } from '../lib/uuid';
import { TagEditor } from './TagEditor';

interface ToolDef {
  id: NewSessionTool;
  name: string;
  icon: string;
  hint: string;
}

function relativeWhen(ms: number): string {
  const diff = Date.now() - ms;
  if (diff < 60_000) return 'just now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  if (diff < 604_800_000) return `${Math.floor(diff / 86_400_000)}d ago`;
  return new Date(ms).toLocaleDateString();
}

const TOOLS: ToolDef[] = [
  { id: 'claude-code', name: 'Claude Code', icon: '🟠', hint: 'claude' },
  { id: 'codex', name: 'Codex', icon: '🟢', hint: 'codex' },
  { id: 'shell', name: 'Shell', icon: '⬛', hint: '$SHELL' }
];

interface Props {
  onClose: () => void;
  // Open the dedicated ResumeDialog. The inline "you have N prior
  // sessions in this folder" hint triggers this when there's more than
  // one candidate; single candidates resume directly.
  onOpenResume?: () => void;
}

// Resolve the (cmd, args) prettyd should spawn for the selected tool.
// Skip-perms maps to --dangerously-skip-permissions (Claude) or
// --dangerously-bypass-approvals-and-sandbox (Codex) — full access, no
// prompts, for both.
//
// For Claude Code we always pass `--session-id <uuid>` so Claude uses
// the exact session ID we control. Two big benefits:
//   1. No auto-resume picker. Claude's default behavior in a cwd with
//      prior sessions is to show its resume picker, which fills the
//      buffer with options and feels like "the page never stops
//      loading." Pinning a fresh uuid skips that — Claude starts
//      brand new.
//   2. The JSONL filename is deterministic (<uuid>.jsonl), so the
//      JSONL watcher in prettyd doesn't have to guess via mtime /
//      birthtime heuristics — it reads exactly our file.
//
// Resume case (when the caller passes a resumeSessionId) uses
// `--resume <id>` so Claude continues that conversation. No fresh
// uuid in that path.
function resolveCommand(
  tool: NewSessionTool,
  skipPerms: boolean,
  resumeSessionId: string | null
): { cmd: string | undefined; args: string[] | undefined } {
  if (tool === 'claude-code') {
    const args: string[] = [];
    if (skipPerms) args.push('--dangerously-skip-permissions');
    if (resumeSessionId) {
      args.push('--resume', resumeSessionId);
    } else {
      args.push('--session-id', randomUUID());
    }
    return { cmd: 'claude', args };
  }
  if (tool === 'codex') {
    // Skip-perms is the DEFAULT and maps to codex's exact twin of Claude's
    // --dangerously-skip-permissions: `--dangerously-bypass-approvals-and-
    // sandbox` (no sandbox, no approval prompts). codex >=0.137 removed
    // `--full-auto`, and workspace-write still boxed codex to the project —
    // we now match Claude's full-access posture. Unchecking skip-perms drops
    // to a sandboxed, prompting codex (workspace-write + on-request).
    return {
      cmd: 'codex',
      args: skipPerms
        ? ['--dangerously-bypass-approvals-and-sandbox']
        : ['--sandbox', 'workspace-write', '--ask-for-approval', 'on-request']
    };
  }
  // shell — let prettyd default to $SHELL
  return { cmd: undefined, args: undefined };
}

// Pull the Claude session id out of a prettyd session's args. Claude
// is always launched with either `--session-id <uuid>` (fresh start,
// see resolveCommand) or `--resume <uuid>` (resumed conversation).
// Either way, that uuid IS the conversation id Claude writes to
// <uuid>.jsonl — which is what the resume picker enumerates. We use
// this to hide already-open sessions from the inline hint so the user
// doesn't accidentally open a second window onto the same JSONL.
function extractClaudeSessionId(args: string[]): string | null {
  for (let i = 0; i < args.length - 1; i++) {
    if (args[i] === '--session-id' || args[i] === '--resume') {
      return args[i + 1] ?? null;
    }
  }
  return null;
}

export function NewSessionDialog({ onClose, onOpenResume }: Props): JSX.Element {
  const create = useSessions((s) => s.create);
  const openSessions = useSessions((s) => s.sessions);
  const [initialDefaults] = useState(readNewSessionDefaults);
  const [tool, setTool] = useState<NewSessionTool>(initialDefaults.tool);
  const [skipPerms, setSkipPerms] = useState(initialDefaults.skipPerms);
  const [cwd, setCwd] = useState(initialDefaults.cwd);
  const [tags, setTags] = useState<Record<string, string>>(initialDefaults.tags);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Resumable sessions on disk. Loaded once when the dialog opens.
  // Only used now to power the inline "you have prior sessions here"
  // hint; the real picker lives in ResumeDialog.
  const [resumable, setResumable] = useState<ResumableSession[] | null>([]);

  useEffect(() => {
    if (tool !== 'claude-code') return;
    let alive = true;
    void fetchResumableSessions()
      .then((s) => { if (alive) setResumable(s); })
      .catch(() => { if (alive) setResumable(null); });
    return () => { alive = false; };
  }, [tool]);

  // Sessions already open as prettyd tabs — exclude these from the
  // inline hint so we don't suggest resuming what's already on screen.
  const openClaudeIds = useMemo(() => {
    const ids = new Set<string>();
    for (const s of openSessions) {
      if (s.tool !== 'claude-code') continue;
      const id = extractClaudeSessionId(s.args);
      if (id) ids.add(id);
    }
    return ids;
  }, [openSessions]);

  // Sessions specifically inside the currently-selected cwd that are
  // NOT already open — drives the inline resume hint.
  const sessionsForCwd = useMemo(() => {
    if (!resumable || !cwd.trim()) return [];
    const target = cwd.trim();
    return resumable.filter((s) => s.cwd === target && !openClaudeIds.has(s.sessionId));
  }, [resumable, cwd, openClaudeIds]);

  const startSession = async (resumeId: string | null): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const { cmd, args } = resolveCommand(tool, skipPerms, resumeId);
      const resumeCwd = resumeId
        ? (resumable?.find((s) => s.sessionId === resumeId)?.cwd ?? cwd.trim())
        : cwd.trim();
      await create({
        cmd,
        args,
        cwd: resumeCwd || undefined,
        cols: initialDefaults.cols,
        rows: initialDefaults.rows,
        tags
      });
      onClose();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const submit = (e: React.FormEvent): void => {
    e.preventDefault();
    void startSession(null);
  };

  const showSkipPerms = tool === 'claude-code' || tool === 'codex';

  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <form className="dialog dialog-wide" onClick={(e) => e.stopPropagation()} onSubmit={submit}>
        <header className="dialog-head">
          <h2 className="dialog-title">+ New session</h2>
          {onOpenResume ? (
            <button
              type="button"
              className="dialog-head-link"
              onClick={onOpenResume}
            >
              ↺ Resume instead
            </button>
          ) : null}
        </header>
        <div className="dialog-body">
          <div className="field">
            <span className="field-label">Tool</span>
            <div className="tool-selector">
              {TOOLS.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  className={`tool-option${tool === t.id ? ' is-active' : ''}`}
                  onClick={() => setTool(t.id)}
                >
                  <span className="tool-icon">{t.icon}</span>
                  <span className="tool-name">{t.name}</span>
                </button>
              ))}
            </div>
          </div>
          <div className="field">
            <span className="field-label">Working directory</span>
            <DirectoryBrowser value={cwd} onChange={setCwd} />
          </div>
          <div className="field">
            <span className="field-label">Tags <span className="field-optional">optional · defaults are editable</span></span>
            <TagEditor value={tags} onChange={setTags} disabled={busy} />
          </div>
          {showSkipPerms ? (
            <label className="field-checkbox">
              <input
                type="checkbox"
                checked={skipPerms}
                onChange={(e) => setSkipPerms(e.target.checked)}
              />
              <span className="field-checkbox-body">
                <span>Skip permissions</span>
                <span className="field-hint">
                  {tool === 'claude-code' ? '--dangerously-skip-permissions' : '--dangerously-bypass-approvals-and-sandbox'}
                </span>
              </span>
            </label>
          ) : null}
          {/* Inline hint — when the chosen cwd has prior sessions, we
              point at the dedicated Resume dialog. Exactly-one case
              resumes inline (since identification is already clear);
              the multi case bounces to ResumeDialog where the user
              can pick deliberately. Already-open sessions are filtered
              upstream so we never recommend reopening a live tab. */}
          {tool === 'claude-code' && sessionsForCwd.length > 0 ? (
            sessionsForCwd.length === 1 ? (
              <button
                type="button"
                className="resume-hint"
                onClick={() => void startSession(sessionsForCwd[0].sessionId)}
                disabled={busy}
                title={sessionsForCwd[0].firstUserMessage ?? ''}
              >
                ↺ Resume “{(sessionsForCwd[0].firstUserMessage ?? '(no user input yet)').slice(0, 60)}
                {(sessionsForCwd[0].firstUserMessage ?? '').length > 60 ? '…' : ''}” ({relativeWhen(sessionsForCwd[0].modifiedAt)})
              </button>
            ) : (
              <button
                type="button"
                className="resume-hint"
                onClick={onOpenResume}
              >
                {sessionsForCwd.length} prior sessions in this folder · ↺ Resume?
              </button>
            )
          ) : null}
          {error ? <div className="dialog-error">{error}</div> : null}
          <div className="dialog-actions">
            <button type="button" className="btn btn-ghost" onClick={onClose} disabled={busy}>Cancel</button>
            <button type="submit" className="btn btn-primary" disabled={busy || !cwd.trim()}>
              {busy ? 'Starting…' : 'Start'}
            </button>
          </div>
        </div>
      </form>
    </div>
  );
}
