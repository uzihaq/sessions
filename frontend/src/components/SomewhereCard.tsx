import { useCallback, useEffect, useMemo, useState } from 'react';
import { getSomewhereCLIStatus, isTauri, type SomewhereCLIStatus } from '../lib/tauriBridge';

const FALLBACK_INSTALL_COMMAND = 'npm install -g @somewhere-tech/cli';

export function SomewhereCard(): JSX.Element {
  const [status, setStatus] = useState<SomewhereCLIStatus | null>(null);
  const [checking, setChecking] = useState(isTauri);
  const [message, setMessage] = useState<string | null>(null);

  const refresh = useCallback(async (): Promise<void> => {
    if (!isTauri()) return;
    setChecking(true);
    setMessage(null);
    try {
      setStatus(await getSomewhereCLIStatus());
    } catch (reason) {
      setMessage(reason instanceof Error ? reason.message : 'Could not inspect the Somewhere CLI');
    } finally {
      setChecking(false);
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  const command = useMemo(() => {
    if (!status?.installed) return status?.installCommand ?? FALLBACK_INSTALL_COMMAND;
    return status.updateAvailable ? status.updateCommand : 'somewhere docs start';
  }, [status]);

  const copyLabel = !status?.installed
    ? 'Copy install command'
    : status.updateAvailable
      ? 'Copy update command'
      : 'Copy docs command';

  const statusLabel = checking
    ? 'Checking CLI…'
    : !isTauri()
      ? 'Check it in Sessions.app'
      : !status?.installed
        ? 'CLI not installed'
        : status.updateAvailable
          ? `${status.installedVersion ?? 'CLI'} installed · ${status.latestVersion ?? 'update'} available`
          : status.latestVersion
            ? `CLI ${status.installedVersion ?? ''} · up to date`
            : `CLI ${status.installedVersion ?? ''} · update check unavailable`;

  const copyCommand = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(command);
      setMessage('Command copied.');
    } catch {
      setMessage(`Copy this command: ${command}`);
    }
  };

  return (
    <section className="somewhere-card">
      <div className="somewhere-card-copy">
        <span className="connections-section-kicker">somewhere.tech · optional</span>
        <h2>Build beyond your laptop</h2>
        <p>Give your coding agent deploys, databases, auth, storage, logs, and MCP from one CLI. Sessions stays free and local; Somewhere is there when an app needs a backend.</p>
        <div className="somewhere-actions">
          <a className="btn" href="https://somewhere.tech" target="_blank" rel="noreferrer">Explore somewhere.tech ↗</a>
          {isTauri() ? <button type="button" className="btn btn-ghost" disabled={checking} onClick={() => void refresh()}>{checking ? 'Checking…' : 'Check again'}</button> : null}
        </div>
      </div>
      <div className={`somewhere-cli${status?.updateAvailable ? ' has-update' : ''}`}>
        <header>
          <span>Somewhere CLI</span>
          <strong>{statusLabel}</strong>
        </header>
        <code>{command}</code>
        <button type="button" className="somewhere-copy" onClick={() => void copyCommand()}>{copyLabel}</button>
        {message ? <small role="status">{message}</small> : status?.detail ? <small>{status.detail}</small> : null}
      </div>
    </section>
  );
}
