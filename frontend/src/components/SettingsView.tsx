import { useEffect, useRef, useState } from 'react';
import {
  fetchAISettings,
  fetchClaudeSettings,
  fetchProfiles,
  fetchRecapSettings,
  updateAISettings,
  updateClaudeSettings,
  updateRecapSettings,
  type AIProvider,
  type AccountProfile,
  type RecapProvider
} from '../api/sessionsd';
import type { ClaudeSettings } from '../types';
import { useServers } from '../lib/servers';
import {
  checkForNativeUpdate,
  installNativeUpdate,
  isTauri,
  type NativeUpdateInfo,
  type NativeUpdateProgress
} from '../lib/tauriBridge';
import { ConnectionsView } from './ConnectionsView';
import type { ThemeMode } from './ProductSidebar';
import { SomewhereCard } from './SomewhereCard';

type Section = 'general' | 'agents' | 'accounts' | 'network' | 'cloud' | 'notifications';

interface Props {
  theme: ThemeMode;
  onThemeChange: (theme: ThemeMode) => void;
}

export function SettingsView({ theme, onThemeChange }: Props): JSX.Element {
  const activeServerId = useServers((state) => state.activeId);
  const native = isTauri();
  const [section, setSection] = useState<Section>('general');
  const [aiProvider, setAIProvider] = useState<AIProvider>('codex');
  const [aiBusy, setAIBusy] = useState(false);
  const [aiAvailable, setAIAvailable] = useState(true);
  const [aiMessage, setAIMessage] = useState<string | null>(null);
  const [recapProvider, setRecapProvider] = useState<RecapProvider>('off');
  const [recapBusy, setRecapBusy] = useState(false);
  const [recapAvailable, setRecapAvailable] = useState(true);
  const [recapMessage, setRecapMessage] = useState<string | null>(null);
  const [claudeSettings, setClaudeSettings] = useState<ClaudeSettings>({
    remoteControl: 'inherit', permissionMode: 'bypassPermissions', model: '', effort: 'inherit',
    chrome: 'inherit', somewhereMcp: 'inherit', remoteControlNamePrefix: ''
  });
  const [claudeBusy, setClaudeBusy] = useState(false);
  const [claudeAvailable, setClaudeAvailable] = useState(true);
  const [claudeMessage, setClaudeMessage] = useState<string | null>(null);
  const [profiles, setProfiles] = useState<AccountProfile[]>([]);
  const [updateInfo, setUpdateInfo] = useState<NativeUpdateInfo | null>(null);
  const [updateProgress, setUpdateProgress] = useState<NativeUpdateProgress | null>(null);
  const [updateBusy, setUpdateBusy] = useState(false);
  const [updateMessage, setUpdateMessage] = useState<string | null>(null);
  const aiGeneration = useRef(0);
  const recapGeneration = useRef(0);
  const claudeGeneration = useRef(0);

  useEffect(() => {
    const controller = new AbortController();
    void fetchProfiles(controller.signal).then(setProfiles).catch(() => {
      if (!controller.signal.aborted) setProfiles([]);
    });
    const nextClaude = claudeGeneration.current + 1;
    claudeGeneration.current = nextClaude;
    setClaudeBusy(false);
    setClaudeAvailable(true);
    setClaudeMessage(null);
    void fetchClaudeSettings(controller.signal)
      .then((settings) => {
        if (claudeGeneration.current === nextClaude) setClaudeSettings(settings);
      })
      .catch(() => {
        if (!controller.signal.aborted && claudeGeneration.current === nextClaude) {
          setClaudeAvailable(false);
          setClaudeMessage('Claude defaults require a current Sessions runtime.');
        }
      });
    if (!native) return () => controller.abort();

    const nextAI = aiGeneration.current + 1;
    const nextRecap = recapGeneration.current + 1;
    aiGeneration.current = nextAI;
    recapGeneration.current = nextRecap;
    setAIBusy(false);
    setRecapBusy(false);
    setAIAvailable(true);
    setRecapAvailable(true);
    setAIMessage(null);
    setRecapMessage(null);
    void fetchAISettings(controller.signal)
      .then((settings) => {
        if (aiGeneration.current === nextAI) setAIProvider(settings.provider);
      })
      .catch(() => {
        if (!controller.signal.aborted && aiGeneration.current === nextAI) {
          setAIAvailable(false);
          setAIMessage('AI search requires a current Sessions runtime.');
        }
      });
    void fetchRecapSettings(controller.signal)
      .then((settings) => {
        if (recapGeneration.current === nextRecap) setRecapProvider(settings.provider);
      })
      .catch(() => {
        if (!controller.signal.aborted && recapGeneration.current === nextRecap) {
          setRecapAvailable(false);
          setRecapMessage('Daily recaps require a current Sessions runtime.');
        }
      });
    return () => controller.abort();
  }, [activeServerId, native]);

  const saveAIProvider = async (provider: AIProvider): Promise<void> => {
    if (!native || aiBusy || !aiAvailable) return;
    const previous = aiProvider;
    const generation = aiGeneration.current + 1;
    aiGeneration.current = generation;
    setAIBusy(true);
    setAIProvider(provider);
    setAIMessage(null);
    try {
      const saved = await updateAISettings({ provider });
      if (aiGeneration.current !== generation) return;
      setAIProvider(saved.provider);
      setAIMessage('Smart search provider saved.');
    } catch (error) {
      if (aiGeneration.current === generation) {
        setAIProvider(previous);
        setAIMessage(error instanceof Error ? error.message : 'Could not save smart search settings.');
      }
    } finally {
      if (aiGeneration.current === generation) setAIBusy(false);
    }
  };

  const saveRecapProvider = async (provider: RecapProvider): Promise<void> => {
    if (!native || recapBusy || !recapAvailable) return;
    const previous = recapProvider;
    const generation = recapGeneration.current + 1;
    recapGeneration.current = generation;
    setRecapBusy(true);
    setRecapProvider(provider);
    setRecapMessage(null);
    try {
      const saved = await updateRecapSettings({ provider });
      if (recapGeneration.current !== generation) return;
      setRecapProvider(saved.provider);
      setRecapMessage(saved.provider === 'off' ? 'Daily model calls are off.' : 'Today recap provider saved.');
    } catch (error) {
      if (recapGeneration.current === generation) {
        setRecapProvider(previous);
        setRecapMessage(error instanceof Error ? error.message : 'Could not save recap settings.');
      }
    } finally {
      if (recapGeneration.current === generation) setRecapBusy(false);
    }
  };

  const saveClaudeSettings = async (next: ClaudeSettings): Promise<void> => {
    if (claudeBusy || !claudeAvailable) return;
    const previous = claudeSettings;
    const generation = claudeGeneration.current + 1;
    claudeGeneration.current = generation;
    setClaudeBusy(true);
    setClaudeSettings(next);
    setClaudeMessage(null);
    try {
      const saved = await updateClaudeSettings(next);
      if (claudeGeneration.current !== generation) return;
      setClaudeSettings(saved);
      setClaudeMessage('Claude defaults saved. New sessions will use them.');
    } catch (error) {
      if (claudeGeneration.current === generation) {
        setClaudeSettings(previous);
        setClaudeMessage(error instanceof Error ? error.message : 'Could not save Claude defaults.');
      }
    } finally {
      if (claudeGeneration.current === generation) setClaudeBusy(false);
    }
  };

  const checkForUpdate = async (): Promise<void> => {
    if (!native || updateBusy) return;
    setUpdateBusy(true);
    setUpdateMessage(null);
    setUpdateProgress(null);
    try {
      const available = await checkForNativeUpdate();
      setUpdateInfo(available);
      setUpdateMessage(available ? `Sessions ${available.version} is available.` : 'Sessions is up to date.');
    } catch (error) {
      setUpdateInfo(null);
      setUpdateMessage(error instanceof Error ? error.message : 'Could not check for updates.');
    } finally {
      setUpdateBusy(false);
    }
  };

  const installUpdate = async (): Promise<void> => {
    if (!native || !updateInfo || updateBusy) return;
    setUpdateBusy(true);
    setUpdateMessage('Downloading update…');
    try {
      await installNativeUpdate((progress) => {
        setUpdateProgress(progress);
        if (progress.totalBytes) {
          const percent = Math.min(100, Math.round((progress.downloadedBytes / progress.totalBytes) * 100));
          setUpdateMessage(`Downloading update… ${percent}%`);
        }
      });
    } catch (error) {
      setUpdateMessage(error instanceof Error ? error.message : 'Could not install update.');
      setUpdateBusy(false);
    }
  };

  return (
    <div className="settings-view">
      <aside className="settings-sections">
        <header><span>Preferences</span><h1>Settings</h1></header>
        {[
          ['general', 'General'],
          ['agents', 'Agents & models'],
          ['accounts', 'Accounts & profiles'],
          ['network', 'Access & networking'],
          ['cloud', 'Cloud & backup'],
          ['notifications', 'Notifications & updates']
        ].map(([id, label]) => (
          <button type="button" key={id} className={section === id ? 'is-active' : ''} onClick={() => setSection(id as Section)}>{label}</button>
        ))}
      </aside>
      <main className="settings-panel">
        {section === 'general' ? (
          <GeneralSettings theme={theme} onThemeChange={onThemeChange} />
        ) : section === 'agents' ? (
          <AgentSettings
            native={native}
            aiProvider={aiProvider}
            aiBusy={aiBusy}
            aiAvailable={aiAvailable}
            aiMessage={aiMessage}
            recapProvider={recapProvider}
            recapBusy={recapBusy}
            recapAvailable={recapAvailable}
            recapMessage={recapMessage}
            claudeSettings={claudeSettings}
            claudeBusy={claudeBusy}
            claudeAvailable={claudeAvailable}
            claudeMessage={claudeMessage}
            onAIProvider={saveAIProvider}
            onRecapProvider={saveRecapProvider}
            onClaudeSettings={saveClaudeSettings}
            onClaudeDraft={setClaudeSettings}
          />
        ) : section === 'accounts' ? (
          <AccountSettings profiles={profiles} />
        ) : section === 'network' ? (
          <ConnectionsView />
        ) : section === 'cloud' ? (
          <section className="settings-page settings-cloud-page">
            <span className="settings-kicker">Somewhere account</span>
            <h1>Cloud & backup</h1>
            <p>Encrypted local-first backup is available now. Hosted library, search, and worker controls are clearly staged below.</p>
            <SomewhereCard />
          </section>
        ) : (
          <NotificationSettings
            native={native}
            updateInfo={updateInfo}
            updateProgress={updateProgress}
            updateBusy={updateBusy}
            updateMessage={updateMessage}
            onCheck={checkForUpdate}
            onInstall={installUpdate}
          />
        )}
      </main>
    </div>
  );
}

function GeneralSettings({ theme, onThemeChange }: Props): JSX.Element {
  return (
    <section className="settings-page">
      <span className="settings-kicker">Sessions app</span>
      <h1>General</h1>
      <p>Choose how the operations inbox looks and behaves on this Mac.</p>
      <div className="settings-card">
        <h2>Appearance</h2>
        <div className="theme-choice">
          <button type="button" className={theme === 'light' ? 'is-active' : ''} onClick={() => onThemeChange('light')}><span className="theme-preview is-light" />Light</button>
          <button type="button" className={theme === 'dark' ? 'is-active' : ''} onClick={() => onThemeChange('dark')}><span className="theme-preview is-dark" />Dark</button>
        </div>
      </div>
      <div className="settings-card">
        <h2>Session workspace</h2>
        <label className="settings-toggle"><span><strong>Collapse finished children</strong><small>Keeps manager sessions readable by grouping completed delegates.</small></span><input type="checkbox" checked readOnly /></label>
        <label className="settings-toggle"><span><strong>Five pinned managers</strong><small>Pin the conversations you use to coordinate everything else.</small></span><input type="checkbox" checked readOnly /></label>
      </div>
    </section>
  );
}

interface AgentSettingsProps {
  native: boolean;
  aiProvider: AIProvider;
  aiBusy: boolean;
  aiAvailable: boolean;
  aiMessage: string | null;
  recapProvider: RecapProvider;
  recapBusy: boolean;
  recapAvailable: boolean;
  recapMessage: string | null;
  onAIProvider: (provider: AIProvider) => Promise<void>;
  onRecapProvider: (provider: RecapProvider) => Promise<void>;
  claudeSettings: ClaudeSettings;
  claudeBusy: boolean;
  claudeAvailable: boolean;
  claudeMessage: string | null;
  onClaudeSettings: (settings: ClaudeSettings) => Promise<void>;
  onClaudeDraft: (settings: ClaudeSettings) => void;
}

function AgentSettings(props: AgentSettingsProps): JSX.Element {
  return (
    <section className="settings-page">
      <span className="settings-kicker">Local, explicit calls</span>
      <h1>Agents & models</h1>
      <p>Choose which already-authenticated local agent powers smart search and opt-in daily recaps.</p>
      {!props.native ? <div className="settings-message">These controls are available only in the signed Sessions app.</div> : null}
      <div className="settings-card">
        <h2>Claude session defaults</h2>
        <p>Applied only to sessions launched by Sessions. Claude’s own settings files remain untouched.</p>
        <label className="settings-select-row"><span><strong>Remote Control</strong><small>Start new Claude sessions with `/rc` available through claude.ai and mobile.</small></span><select value={props.claudeSettings.remoteControl} disabled={props.claudeBusy || !props.claudeAvailable} onChange={(event) => void props.onClaudeSettings({ ...props.claudeSettings, remoteControl: event.currentTarget.value as ClaudeSettings['remoteControl'] })}><option value="inherit">Inherit from Claude</option><option value="on">On for new sessions</option><option value="off">Off for new sessions</option></select></label>
        <label className="settings-select-row"><span><strong>Permission mode</strong><small>Bypass preserves Sessions’ current behavior; choose Claude default to retain prompts.</small></span><select value={props.claudeSettings.permissionMode} disabled={props.claudeBusy || !props.claudeAvailable} onChange={(event) => void props.onClaudeSettings({ ...props.claudeSettings, permissionMode: event.currentTarget.value as ClaudeSettings['permissionMode'] })}><option value="inherit">Claude default</option><option value="manual">Manual</option><option value="acceptEdits">Accept edits</option><option value="auto">Auto</option><option value="plan">Plan</option><option value="dontAsk">Don’t ask</option><option value="bypassPermissions">Bypass permissions</option></select></label>
        <label className="settings-select-row"><span><strong>Model</strong><small>Leave blank to use Claude’s selected default model.</small></span><input value={props.claudeSettings.model} disabled={props.claudeBusy || !props.claudeAvailable} maxLength={128} placeholder="Provider default" onChange={(event) => props.onClaudeDraft({ ...props.claudeSettings, model: event.currentTarget.value })} onBlur={() => void props.onClaudeSettings(props.claudeSettings)} onKeyDown={(event) => { if (event.key === 'Enter') event.currentTarget.blur(); }} /></label>
        <label className="settings-select-row"><span><strong>Effort</strong><small>Leave inherited unless you want every new Claude session to use the same effort.</small></span><select value={props.claudeSettings.effort} disabled={props.claudeBusy || !props.claudeAvailable} onChange={(event) => void props.onClaudeSettings({ ...props.claudeSettings, effort: event.currentTarget.value as ClaudeSettings['effort'] })}><option value="inherit">Inherit from Claude</option><option value="low">Low</option><option value="medium">Medium</option><option value="high">High</option><option value="xhigh">Extra high</option><option value="max">Max</option></select></label>
        <label className="settings-select-row"><span><strong>Chrome integration</strong><small>Explicitly enable or disable Claude in Chrome for Sessions launches.</small></span><select value={props.claudeSettings.chrome} disabled={props.claudeBusy || !props.claudeAvailable} onChange={(event) => void props.onClaudeSettings({ ...props.claudeSettings, chrome: event.currentTarget.value as ClaudeSettings['chrome'] })}><option value="inherit">Inherit from Claude</option><option value="on">On</option><option value="off">Off</option></select></label>
        <label className="settings-select-row"><span><strong>Somewhere MCP</strong><small>Adopts an existing equivalent registration; otherwise launches the local `somewhere mcp` adapter without copying its credential.</small></span><select value={props.claudeSettings.somewhereMcp} disabled={props.claudeBusy || !props.claudeAvailable} onChange={(event) => void props.onClaudeSettings({ ...props.claudeSettings, somewhereMcp: event.currentTarget.value as ClaudeSettings['somewhereMcp'] })}><option value="inherit">Use Claude configuration</option><option value="ensure">Ensure enabled</option></select></label>
        <label className="settings-select-row"><span><strong>Remote Control name prefix</strong><small>Optional label prefix for sessions visible on claude.ai.</small></span><input value={props.claudeSettings.remoteControlNamePrefix} disabled={props.claudeBusy || !props.claudeAvailable} maxLength={64} placeholder="This Mac" onChange={(event) => props.onClaudeDraft({ ...props.claudeSettings, remoteControlNamePrefix: event.currentTarget.value })} onBlur={() => void props.onClaudeSettings(props.claudeSettings)} onKeyDown={(event) => { if (event.key === 'Enter') event.currentTarget.blur(); }} /></label>
        {props.claudeMessage ? <div className="settings-message" role="status">{props.claudeMessage}</div> : null}
      </div>
      <div className="settings-card">
        <h2>Smart search</h2>
        <label className="settings-select-row">
          <span><strong>Planning provider</strong><small>The natural-language query is sent; Sessions then searches its local index.</small></span>
          <select
            value={props.aiProvider}
            disabled={!props.native || props.aiBusy || !props.aiAvailable}
            onChange={(event) => void props.onAIProvider(event.currentTarget.value as AIProvider)}
          ><option value="codex">Codex</option><option value="claude">Claude</option></select>
        </label>
        {props.aiMessage ? <div className="settings-message">{props.aiMessage}</div> : null}
      </div>
      <div className="settings-card">
        <h2>Today recap</h2>
        <label className="settings-select-row">
          <span><strong>Summary provider</strong><small>Opt in. A call happens only when you request a recap.</small></span>
          <select
            value={props.recapProvider}
            disabled={!props.native || props.recapBusy || !props.recapAvailable}
            onChange={(event) => void props.onRecapProvider(event.currentTarget.value as RecapProvider)}
          ><option value="off">Off</option><option value="codex">Codex</option><option value="claude">Claude</option></select>
        </label>
        {props.recapMessage ? <div className="settings-message">{props.recapMessage}</div> : null}
      </div>
      <div className="settings-card">
        <h2>Model</h2>
        <div className="settings-static-row"><span><strong>Provider default</strong><small>Sessions avoids hardcoding a model. Explicit per-feature models are coming soon.</small></span><span className="coming-soon-pill">Coming soon</span></div>
      </div>
    </section>
  );
}

function AccountSettings({ profiles }: { profiles: AccountProfile[] }): JSX.Element {
  return (
    <section className="settings-page">
      <span className="settings-kicker">Isolated credentials</span>
      <h1>Accounts & profiles</h1>
      <p>Profiles let one Mac run multiple Claude or Codex logins without mixing provider history.</p>
      <div className="settings-card">
        <h2>Discovered profiles</h2>
        <div className="settings-profile-list">
          {profiles.map((profile) => <div key={`${profile.tool}:${profile.name}`}><span className={`profile-provider is-${profile.tool}`}>{profile.tool === 'claude' ? 'Claude' : 'Codex'}</span><strong>{profile.name}</strong><small>{profile.sessions.length} known session{profile.sessions.length === 1 ? '' : 's'}</small></div>)}
          {profiles.length === 0 ? <p>No named profiles yet. Choose “Add another login” in New Session.</p> : null}
        </div>
      </div>
      <div className="settings-coming-card"><span>Fleet · Coming soon</span><h2>Profile health across machines</h2><p>Fleet will show which accounts are available on each machine without copying credentials between them.</p></div>
    </section>
  );
}

interface NotificationSettingsProps {
  native: boolean;
  updateInfo: NativeUpdateInfo | null;
  updateProgress: NativeUpdateProgress | null;
  updateBusy: boolean;
  updateMessage: string | null;
  onCheck: () => Promise<void>;
  onInstall: () => Promise<void>;
}

function NotificationSettings(props: NotificationSettingsProps): JSX.Element {
  return (
    <section className="settings-page">
      <span className="settings-kicker">Signed desktop delivery</span>
      <h1>Notifications & updates</h1>
      <p>Sessions checks the signed release feed automatically, while installation always stays an explicit action.</p>
      <div className="settings-card">
        <h2>Sessions updates</h2>
        <div className="settings-static-row">
          <span><strong>{props.updateInfo ? `Sessions ${props.updateInfo.version} is ready` : 'Signed release channel'}</strong><small>Updating restarts only the app window. The background service and running sessions continue.</small></span>
          {props.updateInfo ? (
            <button type="button" className="btn btn-primary" disabled={!props.native || props.updateBusy} onClick={() => void props.onInstall()}>Install update</button>
          ) : (
            <button type="button" className="btn btn-ghost" disabled={!props.native || props.updateBusy} onClick={() => void props.onCheck()}>{props.updateBusy ? 'Checking…' : 'Check now'}</button>
          )}
        </div>
        {!props.native ? <div className="settings-message">Update controls are available only in Sessions.app.</div> : null}
        {props.updateMessage ? <div className="settings-message" role="status">{props.updateMessage}</div> : null}
        {props.updateBusy && props.updateProgress?.totalBytes ? <progress value={props.updateProgress.downloadedBytes} max={props.updateProgress.totalBytes} aria-label="Update download progress" /> : null}
        {props.updateInfo?.notes ? <p>{props.updateInfo.notes}</p> : null}
      </div>
      <div className="settings-coming-card"><span>Native session alerts · Coming soon</span><h2>Needs-you and completion alerts</h2><p>The notification center will add per-session approval, question, completion, and lost-session rules without relying on the retired browser control surface.</p></div>
    </section>
  );
}
