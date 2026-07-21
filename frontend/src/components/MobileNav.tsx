import { useEffect, useRef, useState, type TouchEvent } from 'react';
import type { SessionInfo } from '../types';
import { getTabLabel, useTabLabel, sessionLabel } from '../lib/tabLabels';
import { ParserIcon } from './ParserIcon';

type MobileTabStatus = 'working' | 'finished' | 'idle';

interface Props {
  sessions: SessionInfo[];
  activeId: string | null;
  layoutMode: 'tabs' | 'fleet' | 'search' | 'usage';
  statusBySession: Record<string, MobileTabStatus>;
  iconBySession: Record<string, string>;
  onSwitch: (id: string) => void;
  onLayoutChange: (mode: 'tabs' | 'fleet' | 'search' | 'usage') => void;
  onNew: () => void;
  onResume: () => void;
}

// Bottom navigation for ≤720px screens. The single lane button accepts
// a horizontal swipe to cycle prev/next. Tap (no swipe) pops the session
// sheet listing all sessions plus new/resume actions.
//
// Heuristic for swipe vs tap:
//   • dx ≥ 50px AND |dx| > |dy|*1.4 → swipe
//   • else → tap
// 600ms upper bound on the gesture so a slow scroll doesn't get
// misinterpreted as a swipe.
export function MobileNav({
  sessions,
  activeId,
  layoutMode,
  statusBySession,
  iconBySession,
  onSwitch,
  onLayoutChange,
  onNew,
  onResume
}: Props): JSX.Element {
  const [sheetOpen, setSheetOpen] = useState(false);
  const laneButtonRef = useRef<HTMLButtonElement>(null);
  const sheetRef = useRef<HTMLDivElement>(null);
  const active = sessions.find((s) => s.id === activeId);
  const idx = activeId ? sessions.findIndex((s) => s.id === activeId) : -1;
  // Use the shared label chain (user override > Claude titles > cwd > cmd)
  // so the hero button matches what SessionTabs shows for the same session.
  const activeUserLabel = useTabLabel(active?.id ?? '');
  const activeLabel = activeUserLabel ?? (active ? sessionLabel(active) : 'No sessions');
  const activeIsWorking = activeId ? statusBySession[activeId] === 'working' : false;

  useEffect(() => {
    if (!sheetOpen) return;
    window.requestAnimationFrame(() => sheetRef.current?.focus());
  }, [sheetOpen]);

  // Tiny haptic helper. Mirrors sessions-tmux: 10ms for taps, 14ms for
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
  const onTouchStart = (e: TouchEvent): void => {
    if (e.touches.length !== 1) { touchRef.current = null; return; }
    const t = e.touches[0];
    if (!t) return;
    touchRef.current = { x: t.clientX, y: t.clientY, t: Date.now() };
    swipedRef.current = false;
  };
  const onTouchEnd = (e: TouchEvent): void => {
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
  const closeSheet = (restoreFocus = true): void => {
    setSheetOpen(false);
    if (restoreFocus) {
      window.requestAnimationFrame(() => laneButtonRef.current?.focus());
    }
  };
  const onHeroClick = (): void => {
    if (swipedRef.current) {
      swipedRef.current = false;
      return;
    }
    haptic(10);
    onLayoutChange('tabs');
    setSheetOpen(true);
  };
  const rowLabel = (s: SessionInfo): string => getTabLabel(s.id) ?? sessionLabel(s);
  const compactCwd = (cwd: string): string => cwd.replace(/^\/(Users|home)\/[^/]+/, '~');
  const openNew = (): void => {
    haptic(10);
    closeSheet(false);
    onNew();
  };
  const openResume = (): void => {
    haptic(10);
    closeSheet(false);
    onResume();
  };

  return (
    <>
      <nav className="mobile-nav" role="navigation" aria-label="Quick navigation">
        <button
          ref={laneButtonRef}
          type="button"
          className={`mn-btn mn-hero${layoutMode === 'tabs' ? ' is-active' : ''}`}
          onClick={onHeroClick}
          onTouchStart={onTouchStart}
          onTouchEnd={onTouchEnd}
          aria-label={`Open session list for ${activeLabel}${activeIsWorking ? ', working' : ''}`}
        >
          {activeIsWorking ? <span className="mn-status-dot working" aria-hidden /> : null}
          <div className="mn-hero-name">{activeLabel}</div>
        </button>
        <MobileDestination label="Fleet" glyph="◫" active={layoutMode === 'fleet'} onClick={() => onLayoutChange('fleet')} />
        <MobileDestination label="Search" glyph="⌕" active={layoutMode === 'search'} onClick={() => onLayoutChange('search')} />
        <MobileDestination label="Usage" glyph="◒" active={layoutMode === 'usage'} onClick={() => onLayoutChange('usage')} />
      </nav>

      {sheetOpen ? (
        <div className="bottom-sheet-backdrop" onClick={() => closeSheet()}>
          <div
            ref={sheetRef}
            className="bottom-sheet"
            role="dialog"
            aria-modal="true"
            aria-labelledby="mobile-session-sheet-title"
            tabIndex={-1}
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
              if (e.key === 'Escape') closeSheet();
            }}
          >
            <div className="bottom-sheet-handle" />
            <h3 className="bottom-sheet-title" id="mobile-session-sheet-title">Sessions</h3>
            <ul className="bottom-sheet-list">
              <li>
                <button type="button" className="bottom-sheet-row bottom-sheet-action" onClick={openNew} aria-label="New session">
                  <span className="bottom-sheet-action-icon" aria-hidden>＋</span>
                  <span className="bottom-sheet-name">New session</span>
                </button>
              </li>
              <li>
                <button type="button" className="bottom-sheet-row bottom-sheet-action" onClick={openResume} aria-label="Resume session">
                  <span className="bottom-sheet-action-icon" aria-hidden>⤴</span>
                  <span className="bottom-sheet-name">Resume…</span>
                </button>
              </li>
              {sessions.map((s) => (
                <li key={s.id}>
                  <button
                    type="button"
                    className={`bottom-sheet-row${s.id === activeId ? ' is-active' : ''}`}
                    onClick={() => {
                      haptic(10);
                      onSwitch(s.id);
                      closeSheet();
                    }}
                    aria-label={`Switch to ${rowLabel(s)}${statusBySession[s.id] === 'working' ? ', working' : ''}`}
                  >
                    <span className="bottom-sheet-icon" aria-hidden>
                      <ParserIcon icon={iconBySession[s.id] ?? '⬛'} size={18} />
                    </span>
                    <span className="bottom-sheet-main">
                      <span className="bottom-sheet-name">{rowLabel(s)}</span>
                      <span className="bottom-sheet-cwd">{compactCwd(s.cwd)}</span>
                    </span>
                    {statusBySession[s.id] === 'working' ? (
                      <span className="bottom-sheet-status-dot working" aria-hidden />
                    ) : null}
                  </button>
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

function MobileDestination({ label, glyph, active, onClick }: { label: string; glyph: string; active: boolean; onClick: () => void }): JSX.Element {
  return (
    <button type="button" className={`mn-btn mn-destination${active ? ' is-active' : ''}`} onClick={onClick} aria-label={`Open ${label}`}>
      <span className="mn-destination-icon" aria-hidden>{glyph}</span>
      <span>{label}</span>
    </button>
  );
}
