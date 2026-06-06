import { useEffect, useRef, useState } from 'react';
import { useServers } from '../lib/servers';
import { useSessions } from '../store/sessions';

// Compact dropdown that lives in the app header. Lists known prettyd
// servers, marks the active one, and exposes "+ Add server" to register
// a new one (saved to localStorage). Switching the active server triggers
// re-fetch in useSessions, useTerminal, usePrettyParser, ReflowedView via
// each of their effect-key dependencies on activeServerId.
export function ServerSelector(): JSX.Element {
  const servers = useServers((s) => s.servers);
  const activeId = useServers((s) => s.activeId);
  const setActive = useServers((s) => s.setActive);
  const addServer = useServers((s) => s.addServer);
  const removeServer = useServers((s) => s.removeServer);
  // Surface refresh errors here — if the chosen server is unreachable
  // the user sees an unreachable badge on the trigger instead of just
  // an empty tab strip. error string clears on the next successful
  // refresh in the store.
  const sessionsError = useSessions((s) => s.error);
  const sessionsHydrated = useSessions((s) => s.hydrated);
  const unreachable = !!sessionsError && !sessionsHydrated;
  const active = servers.find((s) => s.id === activeId) ?? servers[0]!;

  const [open, setOpen] = useState(false);
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');
  const [host, setHost] = useState('');
  const [port, setPort] = useState('8787');
  const wrapRef = useRef<HTMLDivElement | null>(null);

  // Close the dropdown on outside click. Pointerdown so it closes BEFORE
  // a click on a tab below it triggers tab activation.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent): void => {
      if (!wrapRef.current) return;
      if (!wrapRef.current.contains(e.target as Node)) {
        setOpen(false);
        setAdding(false);
      }
    };
    document.addEventListener('pointerdown', onDown);
    return () => document.removeEventListener('pointerdown', onDown);
  }, [open]);

  const handleAdd = (): void => {
    const trimmedHost = host.trim();
    const portNum = Number(port);
    if (!trimmedHost || !Number.isFinite(portNum) || portNum <= 0 || portNum > 65535) return;
    const created = addServer({
      name: name.trim() || trimmedHost,
      host: trimmedHost,
      port: portNum
    });
    setActive(created.id);
    setAdding(false);
    setOpen(false);
    setName('');
    setHost('');
    setPort('8787');
  };

  return (
    <div className="server-selector" ref={wrapRef}>
      <button
        type="button"
        className={`server-selector-trigger${unreachable ? ' is-unreachable' : ''}`}
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="listbox"
        aria-expanded={open}
        // Title attribute carries the host:port so it's available on
        // hover but doesn't take up always-visible chrome. The full
        // host is exposed in the dropdown menu rows.
        title={
          unreachable
            ? `Couldn't reach ${active.host}:${active.port}`
            : `${active.name} — ${active.host}:${active.port}`
        }
      >
        <span className="server-selector-icon" aria-hidden>🖥</span>
        <span className="server-selector-name">{active.name}</span>
        {unreachable ? <span className="server-selector-warn" aria-hidden>⚠</span> : null}
        <span className="server-selector-caret" aria-hidden>▾</span>
      </button>
      {open ? (
        <div className="server-selector-menu" role="listbox">
          {servers.map((s) => (
            <div key={s.id} className={`server-selector-row${s.id === activeId ? ' is-active' : ''}`}>
              <button
                type="button"
                className="server-selector-pick"
                onClick={() => { setActive(s.id); setOpen(false); }}
              >
                <span className="server-selector-dot" aria-hidden>{s.id === activeId ? '●' : '○'}</span>
                <span className="server-selector-name">{s.name}</span>
                <span className="server-selector-host">{s.host}:{s.port}</span>
              </button>
              {!s.isDefault ? (
                <button
                  type="button"
                  className="server-selector-remove"
                  title="Remove server"
                  onClick={() => removeServer(s.id)}
                >
                  ×
                </button>
              ) : null}
            </div>
          ))}
          <div className="server-selector-divider" />
          {adding ? (
            <div className="server-selector-add-form">
              <input
                type="text"
                placeholder="Name (e.g. Mac Mini)"
                value={name}
                onChange={(e) => setName(e.target.value)}
                autoFocus
              />
              <input
                type="text"
                placeholder="Host (e.g. 100.86.76.84)"
                value={host}
                onChange={(e) => setHost(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') handleAdd(); }}
              />
              <input
                type="text"
                inputMode="numeric"
                placeholder="Port"
                value={port}
                onChange={(e) => setPort(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') handleAdd(); }}
              />
              <div className="server-selector-add-actions">
                <button type="button" onClick={() => setAdding(false)}>Cancel</button>
                <button type="button" className="primary" onClick={handleAdd}>Add</button>
              </div>
            </div>
          ) : (
            <button
              type="button"
              className="server-selector-add"
              onClick={() => setAdding(true)}
            >
              + Add server…
            </button>
          )}
        </div>
      ) : null}
    </div>
  );
}
