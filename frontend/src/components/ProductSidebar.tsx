import { useEffect, useState, type ReactNode } from 'react';
import {
  checkForNativeUpdate,
  installNativeUpdate,
  isTauri,
  notifyNativeUpdate,
  type NativeUpdateInfo
} from '../lib/tauriBridge';

export type ProductView = 'home' | 'tabs' | 'today' | 'search' | 'fleet' | 'usage' | 'settings';
export type ThemeMode = 'dark' | 'light';

interface Props {
  active: ProductView;
  theme: ThemeMode;
  onNavigate: (view: ProductView) => void;
  onNewSession: () => void;
  onToggleTheme: () => void;
}

const ITEMS: Array<{ id: ProductView; label: string; icon: ReactNode }> = [
  { id: 'home', label: 'Home', icon: <HomeIcon /> },
  { id: 'tabs', label: 'Sessions', icon: <SessionsIcon /> },
  { id: 'today', label: 'Daily', icon: <TodayIcon /> },
  { id: 'search', label: 'Search', icon: <SearchIcon /> },
  { id: 'fleet', label: 'Fleet', icon: <FleetIcon /> },
  { id: 'usage', label: 'Usage', icon: <UsageIcon /> },
  { id: 'settings', label: 'Settings', icon: <SettingsIcon /> }
];

const UPDATE_CHECK_KEY = 'sessions:native-update-check-at';
const UPDATE_NOTIFIED_KEY = 'sessions:native-update-notified-version';
const UPDATE_CHECK_INTERVAL = 6 * 60 * 60 * 1000;

export function ProductSidebar({ active, theme, onNavigate, onNewSession, onToggleTheme }: Props): JSX.Element {
  const [updateInfo, setUpdateInfo] = useState<NativeUpdateInfo | null>(null);
  const [updateBusy, setUpdateBusy] = useState(false);
  const [updateError, setUpdateError] = useState<string | null>(null);

  useEffect(() => {
    if (!isTauri()) return;
    let cancelled = false;
    const automaticCheck = async (): Promise<void> => {
      let last = 0;
      try { last = Number(window.localStorage.getItem(UPDATE_CHECK_KEY) ?? 0); } catch { /* ignore */ }
      if (Date.now() - last < UPDATE_CHECK_INTERVAL) return;
      try {
        const available = await checkForNativeUpdate();
        if (cancelled) return;
        try { window.localStorage.setItem(UPDATE_CHECK_KEY, String(Date.now())); } catch { /* ignore */ }
        setUpdateInfo(available);
        if (!available) return;
        let notified = '';
        try { notified = window.localStorage.getItem(UPDATE_NOTIFIED_KEY) ?? ''; } catch { /* ignore */ }
        if (notified !== available.version) {
          await notifyNativeUpdate(available).catch(() => { /* sidebar remains authoritative */ });
          try { window.localStorage.setItem(UPDATE_NOTIFIED_KEY, available.version); } catch { /* ignore */ }
        }
      } catch {
        // Automatic checks stay silent. Manual checks remain available in
        // Settings → Notifications & updates.
      }
    };
    const startup = window.setTimeout(() => void automaticCheck(), 1_500);
    const interval = window.setInterval(() => void automaticCheck(), UPDATE_CHECK_INTERVAL);
    return () => { cancelled = true; window.clearTimeout(startup); window.clearInterval(interval); };
  }, []);

  const installUpdate = async (): Promise<void> => {
    if (!updateInfo || updateBusy) return;
    setUpdateBusy(true);
    setUpdateError(null);
    try {
      await installNativeUpdate();
    } catch (error) {
      setUpdateError(error instanceof Error ? error.message : 'Could not install the update');
      setUpdateBusy(false);
    }
  };

  return (
    <aside className="product-sidebar">
      <button type="button" className="product-brand" onClick={() => onNavigate('home')} aria-label="Sessions home">
        <span className="product-brand-mark"><img src="/somewhere-logo.svg" alt="" /></span>
        <span className="product-brand-name"><span>Somewhere</span><strong>Sessions</strong></span>
      </button>

      <button type="button" className="product-new-session" onClick={onNewSession}>
        <span aria-hidden>＋</span><span>New Session</span>
      </button>

      <nav className="product-nav" aria-label="Sessions">
        {ITEMS.map((item) => (
          <button
            key={item.id}
            type="button"
            className={`product-nav-item${active === item.id ? ' is-active' : ''}`}
            onClick={() => onNavigate(item.id)}
            aria-current={active === item.id ? 'page' : undefined}
          >
            <span className="product-nav-icon" aria-hidden>{item.icon}</span>
            <span>{item.label}</span>
          </button>
        ))}
      </nav>

      <div className="product-sidebar-footer">
        {updateInfo ? (
          <div className="product-update-card">
            <div><span>Sessions {updateInfo.version}</span><strong>Update available</strong></div>
            <button type="button" disabled={updateBusy} onClick={() => void installUpdate()}>
              {updateBusy ? 'Updating…' : 'Update app'}
            </button>
            {updateError ? <small role="alert">{updateError}</small> : null}
          </div>
        ) : null}
        <a href="https://somewhere.tech" target="_blank" rel="noreferrer" className="somewhere-sidebar-link">
          <img src="/somewhere-logo.svg" alt="" />
          <span>somewhere.tech</span>
        </a>
        <button type="button" className="theme-toggle" onClick={onToggleTheme} title={`Use ${theme === 'dark' ? 'light' : 'dark'} mode`}>
          <span aria-hidden>{theme === 'dark' ? '☾' : '☀'}</span>
          <span>{theme === 'dark' ? 'Dark' : 'Light'}</span>
        </button>
      </div>
    </aside>
  );
}

function Icon({ children }: { children: ReactNode }): JSX.Element {
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">{children}</svg>;
}
function HomeIcon(): JSX.Element { return <Icon><path d="M3 10.5 12 3l9 7.5"/><path d="M5 9.5V21h14V9.5"/><path d="M9 21v-7h6v7"/></Icon>; }
function SessionsIcon(): JSX.Element { return <Icon><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M8 9h8M8 13h8M8 17h5"/></Icon>; }
function TodayIcon(): JSX.Element { return <Icon><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M8 3v4M16 3v4M3 10h18"/></Icon>; }
function SearchIcon(): JSX.Element { return <Icon><circle cx="11" cy="11" r="7"/><path d="m20 20-4-4"/></Icon>; }
function FleetIcon(): JSX.Element { return <Icon><rect x="4" y="3" width="16" height="7" rx="2"/><rect x="4" y="14" width="16" height="7" rx="2"/><path d="M8 6.5h.01M8 17.5h.01"/></Icon>; }
function UsageIcon(): JSX.Element { return <Icon><path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/></Icon>; }
function SettingsIcon(): JSX.Element { return <Icon><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .34 1.88l.06.06-2.83 2.83-.06-.06A1.7 1.7 0 0 0 15 19.4a1.7 1.7 0 0 0-1 .6 1.7 1.7 0 0 0-.4 1.1V21H9.6v-.1A1.7 1.7 0 0 0 8.5 19.4a1.7 1.7 0 0 0-1.88.34l-.06.06-2.83-2.83.06-.06A1.7 1.7 0 0 0 4.6 15a1.7 1.7 0 0 0-.6-1 1.7 1.7 0 0 0-1.1-.4H3V9.6h.1A1.7 1.7 0 0 0 4.6 8.5a1.7 1.7 0 0 0-.34-1.88l-.06-.06 2.83-2.83.06.06A1.7 1.7 0 0 0 9 4.6a1.7 1.7 0 0 0 1-.6 1.7 1.7 0 0 0 .4-1.1V3h4v.1A1.7 1.7 0 0 0 15.5 4.6a1.7 1.7 0 0 0 1.88-.34l.06-.06 2.83 2.83-.06.06A1.7 1.7 0 0 0 19.4 9c.13.38.34.72.6 1 .3.3.68.5 1.1.6h.1v4h-.1A1.7 1.7 0 0 0 19.4 15Z"/></Icon>; }
