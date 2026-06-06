interface Props {
  onNew: () => void;
}

export function EmptyState({ onNew }: Props): JSX.Element {
  return (
    <div className="empty-state">
      {/* Watermark — the Claude product art faded into the background so
          the page reads as "loaded, just empty" rather than "blank /
          broken." Sits behind the call-to-action card. */}
      <img
        src="/claude.png"
        alt=""
        aria-hidden
        className="empty-watermark"
        draggable={false}
      />
      <div className="empty-card">
        <h2 className="empty-title">No active session</h2>
        <p className="empty-sub">
          Start a PTY-backed session. The terminal stream is the source of
          truth — Pretty cards land in Phase 3.
        </p>
        <button className="btn btn-primary" onClick={onNew}>+ New session</button>
      </div>
    </div>
  );
}
