import { useRef, useState } from 'react';
import type { SessionInfo } from '../types';

interface Props {
  sessions: SessionInfo[];
  activeId: string | null;
  isWorking: boolean;
  onSwitch: (id: string) => void;
  onNew: () => void;
}

function shortLabel(s: SessionInfo | undefined): string {
  if (!s) return '—';
  if (s.cwd && s.cwd.length > 0) {
    const parts = s.cwd.split('/').filter(Boolean);
    const last = parts[parts.length - 1];
    if (last) return last;
  }
  return s.cmd || s.id.slice(0, 6);
}

// Bottom navigation for ≤720px screens. Hero "Sessions" button in the
// center accepts a horizontal swipe to cycle prev/next. Tap (no swipe)
// pops the session sheet listing all sessions.
//
// Heuristic for swipe vs tap:
//   • dx ≥ 50px AND |dx| > |dy|*1.4 → swipe
//   • else → tap
// 600ms upper bound on the gesture so a slow scroll doesn't get
// misinterpreted as a swipe.
export function MobileNav({ sessions, activeId, isWorking, onSwitch, onNew }: Props): JSX.Element {
  const [sheetOpen, setSheetOpen] = useState(false);
  const active = sessions.find((s) => s.id === activeId);
  const idx = activeId ? sessions.findIndex((s) => s.id === activeId) : -1;

  // Tiny haptic helper. Mirrors pretty-tmux: 10ms for taps, 14ms for
  // swipes — short enough to feel like an "ack" not a buzz, long
  // enough to register on phones with conservative haptic motors.
  const haptic = (ms: number): void => {
    try {
      (navigator as Navigator & { vibrate?: (n: number) => void }).vibrate?.(ms);
    } catch { /* ignore */ }
  };

  const swipe = (dir: 1 | -1): void => {
    if (sessions.length < 2 || idx < 0) return;
    const next = (idx + dir + sessions.length) % sessions.length;
    const target = sessions[next];
    if (target) {
      onSwitch(target.id);
      haptic(14);
    }
  };

  const touchRef = useRef<{ x: number; y: number; t: number } | null>(null);
  const swipedRef = useRef(false);
  const onTouchStart = (e: React.TouchEvent): void => {
    if (e.touches.length !== 1) { touchRef.current = null; return; }
    const t = e.touches[0];
    if (!t) return;
    touchRef.current = { x: t.clientX, y: t.clientY, t: Date.now() };
    swipedRef.current = false;
  };
  const onTouchEnd = (e: React.TouchEvent): void => {
    const start = touchRef.current;
    touchRef.current = null;
    if (!start) return;
    const ch = e.changedTouches[0];
    if (!ch) return;
    const dx = ch.clientX - start.x;
    const dy = ch.clientY - start.y;
    const dt = Date.now() - start.t;
    if (Math.abs(dx) >= 50 && Math.abs(dx) > Math.abs(dy) * 1.4 && dt < 600) {
      swipedRef.current = true;
      // Swipe left → next, right → prev.
      swipe(dx < 0 ? 1 : -1);
    }
  };
  const onHeroClick = (): void => {
    if (swipedRef.current) {
      swipedRef.current = false;
      return;
    }
    haptic(10);
    setSheetOpen(true);
  };

  return (
    <>
      <nav className="mobile-nav" role="navigation" aria-label="Quick navigation">
        <button
          type="button"
          className="mn-btn mn-side"
          onClick={() => { haptic(10); onNew(); }}
          aria-label="New session"
        >
          <span className="mn-glyph">+</span>
          <span>New</span>
        </button>

        <button
          type="button"
          className="mn-btn mn-hero"
          onClick={onHeroClick}
          onTouchStart={onTouchStart}
          onTouchEnd={onTouchEnd}
          aria-label="Open session list (swipe left/right to switch)"
        >
          <div className="mn-hero-top">
            <span aria-hidden>‹</span>
            <span className="mn-hero-label">Sessions</span>
            <span aria-hidden>›</span>
          </div>
          <div className="mn-hero-name">{shortLabel(active)}</div>
          {sessions.length > 0 ? <span className="mn-badge">{sessions.length}</span> : null}
        </button>

        <button type="button" className="mn-btn mn-side" onClick={() => { haptic(10); setSheetOpen(true); }} aria-label="Status">
          <span className={`mn-status-dot${isWorking ? ' working' : ''}`} aria-hidden />
          <span>{isWorking ? 'Working' : 'Idle'}</span>
        </button>
      </nav>

      {sheetOpen ? (
        <div className="bottom-sheet-backdrop" onClick={() => setSheetOpen(false)}>
          <div className="bottom-sheet" onClick={(e) => e.stopPropagation()}>
            <div className="bottom-sheet-handle" />
            <h3 className="bottom-sheet-title">Sessions</h3>
            <ul className="bottom-sheet-list">
              {sessions.map((s) => (
                <li
                  key={s.id}
                  className={`bottom-sheet-row${s.id === activeId ? ' is-active' : ''}`}
                  onClick={() => {
                    haptic(10);
                    onSwitch(s.id);
                    setSheetOpen(false);
                  }}
                >
                  <span className="bottom-sheet-name">{shortLabel(s)}</span>
                  <span className="bottom-sheet-cmd">{s.cmd}</span>
                </li>
              ))}
              {sessions.length === 0 ? <li className="bottom-sheet-empty">no sessions yet</li> : null}
            </ul>
          </div>
        </div>
      ) : null}
    </>
  );
}
