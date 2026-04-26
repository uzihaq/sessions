import { useState } from 'react';
import { useSessions } from '../store/sessions';

interface Props {
  onClose: () => void;
}

export function NewSessionDialog({ onClose }: Props): JSX.Element {
  const create = useSessions((s) => s.create);
  const [cmd, setCmd] = useState('');
  const [argsRaw, setArgsRaw] = useState('');
  const [cwd, setCwd] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await create({
        cmd: cmd.trim() || undefined,
        args: argsRaw.trim() ? argsRaw.trim().split(/\s+/) : undefined,
        cwd: cwd.trim() || undefined
      });
      onClose();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <form className="dialog" onClick={(e) => e.stopPropagation()} onSubmit={submit}>
        <h2 className="dialog-title">New session</h2>
        <label className="field">
          <span className="field-label">Command</span>
          <input
            className="field-input"
            placeholder="$SHELL"
            value={cmd}
            onChange={(e) => setCmd(e.target.value)}
            autoFocus
          />
        </label>
        <label className="field">
          <span className="field-label">Args</span>
          <input
            className="field-input"
            placeholder="(space-separated)"
            value={argsRaw}
            onChange={(e) => setArgsRaw(e.target.value)}
          />
        </label>
        <label className="field">
          <span className="field-label">Working dir</span>
          <input
            className="field-input"
            placeholder="$HOME"
            value={cwd}
            onChange={(e) => setCwd(e.target.value)}
          />
        </label>
        <div className="dialog-quickrow">
          <button type="button" className="btn btn-ghost" onClick={() => { setCmd('claude'); setArgsRaw(''); }}>
            claude
          </button>
          <button type="button" className="btn btn-ghost" onClick={() => { setCmd(''); setArgsRaw(''); }}>
            shell
          </button>
        </div>
        {error ? <div className="dialog-error">{error}</div> : null}
        <div className="dialog-actions">
          <button type="button" className="btn btn-ghost" onClick={onClose} disabled={busy}>Cancel</button>
          <button type="submit" className="btn btn-primary" disabled={busy}>
            {busy ? 'Starting…' : 'Start'}
          </button>
        </div>
      </form>
    </div>
  );
}
