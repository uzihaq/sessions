import { useEffect, useRef, useState } from 'react';
import {
  isTauri,
  getAutostartEnabled,
  setAutostartEnabled
} from '../lib/tauriBridge';
import { type TextSize, nextSize, sizeLabel, writeTextSize } from '../lib/textSize';
import { ServerSelector } from './ServerSelector';

interface Props {
  textSize: TextSize;
  onTextSizeChange: (size: TextSize) => void;
  onNewSession?: () => void;
}

// Settings popover anchored to a header button. Visible everywhere
// because the text-size picker matters for both browser + Tauri;
// the autostart row only renders in Tauri.
export function SettingsMenu({ textSize, onTextSizeChange, onNewSession }: Props): JSX.Element {
  const tauri = isTauri();
  const [open, setOpen] = useState(false);
  const [autostart, setAutostart] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!tauri || !open) return;
    let cancelled = false;
    void getAutostartEnabled().then((v) => {
      if (!cancelled) {
        setAutostart(v);
        setLoaded(true);
      }
    });
    return () => { cancelled = true; };
  }, [tauri, open]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent): void => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', onDown);
    return () => document.removeEventListener('pointerdown', onDown);
  }, [open]);

  const toggleAutostart = async (): Promise<void> => {
    const next = !autostart;
    setAutostart(next);
    await setAutostartEnabled(next);
  };

  const cycleSize = (): void => {
    const next = nextSize(textSize);
    writeTextSize(next);
    onTextSizeChange(next);
  };

  return (
    <div className="settings-menu" ref={wrapRef}>
      <button
        type="button"
        className="settings-menu-trigger"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        title="Settings"
      >
        ⚙
      </button>
      {open ? (
        <div className="settings-menu-popover" role="menu">
          {onNewSession ? (
            <button
              type="button"
              className="settings-menu-row settings-menu-clickable"
              onClick={() => { setOpen(false); onNewSession(); }}
            >
              <span className="settings-menu-icon">+</span>
              <span className="settings-menu-label">New session</span>
            </button>
          ) : null}
          <button
            type="button"
            className="settings-menu-row settings-menu-clickable"
            onClick={cycleSize}
            title="Cycle text size: Small → Medium → Large"
          >
            <span className="settings-menu-icon">Aa</span>
            <span className="settings-menu-label">Text size</span>
            <span className="settings-menu-value">{sizeLabel(textSize)}</span>
          </button>
          {tauri ? (
            <label className="settings-menu-row">
              <input
                type="checkbox"
                checked={autostart}
                onChange={() => void toggleAutostart()}
                disabled={!loaded}
              />
              <span>Launch at login</span>
            </label>
          ) : null}
          {/* Server selector — "this machine" + IP picker. Tucked into
              Settings because the user doesn't need to see the host:port
              in the chrome all the time; it only matters when switching
              between machines. */}
          <div className="settings-menu-divider" />
          <div className="settings-menu-row settings-menu-server">
            <span className="settings-menu-icon">🖥</span>
            <ServerSelector />
          </div>
        </div>
      ) : null}
    </div>
  );
}
