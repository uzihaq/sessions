import { useEffect, useRef, useState } from 'react';

// Maps the useTerminal hook's status → the four visible states sessions-tmux
// used. `error` and `closed` both fold to `disconnected` for the user;
// internally we still distinguish them in useTerminal so the reconnect
// loop knows whether to retry.
export type ConnStatus =
  | 'connected'
  | 'connecting'
  | 'reconnecting'
  | 'disconnected';

export function fromTerminalStatus(s: string): ConnStatus {
  if (s === 'open') return 'connected';
  if (s === 'connecting') return 'connecting';
  if (s === 'reconnecting') return 'reconnecting';
  return 'disconnected';
}

interface Props {
  status: ConnStatus | null;
}

// Small pill with a colored dot + label. Once the connection settles to
// `connected`, the label fades out after 2s so the happy path stays
// quiet — the dot remains visible. Any transition back to a non-
// connected state immediately re-shows the label.
export function ConnectionStatus({ status }: Props): JSX.Element | null {
  const [showLabel, setShowLabel] = useState(true);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    if (status === 'connected') {
      setShowLabel(true);
      timerRef.current = setTimeout(() => setShowLabel(false), 2000);
    } else {
      setShowLabel(true);
    }
    return () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [status]);

  if (!status) return null;

  const label =
    status === 'connected' ? 'Live'
      : status === 'connecting' ? 'Connecting…'
      : status === 'reconnecting' ? 'Reconnecting…'
      : 'Offline — last known state';

  return (
    <span
      className={`conn-status conn-${status}`}
      role="status"
      aria-live="polite"
      title={label}
    >
      <span className="conn-dot" aria-hidden />
      {(status !== 'connected' || showLabel) ? (
        <span className="conn-label">{label}</span>
      ) : null}
    </span>
  );
}
