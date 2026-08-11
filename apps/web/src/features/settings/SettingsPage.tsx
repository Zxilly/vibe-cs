import { applyLocale, currentLocale, msg, msgf } from '../../shared/i18n';
import {
  Bot,
  Check,
  ChevronRight,
  CircleAlert,
  Database,
  Download,
  FileJson,
  FileVideo2,
  FolderOpen,
  FolderCog,
  Gamepad2,
  HardDrive,
  Clapperboard,
  Info,
  Languages,
  KeyRound,
  Link2,
  MonitorCog,
  Moon,
  PlugZap,
  Radio,
  RefreshCw,
  Save,
  Server,
  Settings2,
  ShieldCheck,
  Sparkles,
  Sun,
  Trash2,
  Unplug,
  Video,
} from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';

import { commands, readableError } from '../../shared/desktop/client';
import { productApi, type ManagedLocations, type UpdateCheckResult, type UpdateInfo } from '../../shared/desktop/product';
import type {
  AppConfig,
  DetectedPaths,
  MediaProxyCleanup,
  MediaRuntimeStatus,
  HlaeStatus,
  LlmTestResult,
  ObsDiagnosis,
  ObsRecordStatus,
  QuickCheckResponse,
  ReplayCacheCleanup,
  ReplayCacheStatus,
  StorageStatus,
} from '../../shared/desktop/dto';
import {
  chooseLocalDirectories,
  chooseLocalFile,
  isDesktopShell,
  openExternalHttpsUrl,
  openLocalDirectory,
  revealLocalPath,
  type LocalDialogFilter,
} from '../../shared/desktop/dialog';
import { useAsyncAction } from '../../shared/hooks/useAsyncAction';
import { useI18n } from '../../shared/i18n';
import { useUiStore } from '../../shared/stores/uiStore';
import { Badge, Button, Card, Field, Notice, PageHeader, Spinner, TextInput } from '../../shared/ui';
import {
  formatObsFrameRate,
  hasUnsavedObsRuntimeSettings,
  retryObsDiagnosis,
} from './obsDiagnostics';
import { ObsTuningSection } from './ObsTuningSection';
import { RecordingCalibrationPanel } from './RecordingCalibrationPanel';

type SettingsTab = 'general' | 'paths' | 'steam' | 'video' | 'analysis' | 'recording';
type SettingsSource = 'loading' | 'service' | 'unavailable';

export const defaultConfig: AppConfig = {
  locale: 'zh-CN',
  theme: 'dark',
  update_manifest_url: '',
  data_dir: '',
  demo_watch_paths: [],
  ffmpeg_path: '',
  ffprobe_path: '',
  preferred_encoder: 'auto',
  cs2_path: '',
  hlae_path: '',
  steam_path: '',
  steam: {
    steam_id: '',
    web_api_key: '',
    authentication_code: '',
    known_share_code: '',
    maximum_results: 20,
  },
  steam_has_web_api_key: false,
  steam_has_authentication_code: false,
  steam_has_share_code: false,
  obs: { host: '127.0.0.1', port: 4455, password: '', executable: '', scene: '' },
  obs_has_password: false,
  llm: { provider: '', model: '', base_url: '', api_key: '', prompt: '' },
  llm_has_api_key: false,
  clear_llm_api_key: false,
  recording: {
    pre_roll_seconds: 3,
    post_roll_seconds: 2.5,
    transition_seconds: 0.35,
    resolution: '1920x1080',
    fps: 60,
    show_radar: true,
    radar_restore_visible: true,
    show_keyboard: false,
    mute_voice: false,
    voice_restore_volume: 1,
    camera_fov: 90,
    camera_fov_restore: 90,
    viewmodel_fov: 68,
    viewmodel_fov_restore: 68,
    flash_alpha: 255,
    flash_alpha_restore: 255,
    grenade_trajectory: false,
    grenade_trajectory_restore: false,
    show_hud: true,
    hud_restore_visible: true,
    isolate_target_voice: false,
    first_person_hud_assets: '',
    obs_realtime_kill_fx_media: '',
    obs_realtime_keyboard_media: '',
    capture_delay_ms: 0,
  },
};

const settingsTabs: Array<{ id: SettingsTab; icon: typeof Settings2 }> = [
  { id: 'general', icon: Settings2 },
  { id: 'paths', icon: FolderCog },
  { id: 'steam', icon: Link2 },
  { id: 'video', icon: MonitorCog },
  { id: 'analysis', icon: Bot },
  { id: 'recording', icon: Video },
];

export function SettingsPage() {
  const { t } = useI18n();
  const tabCopy = {
    general: { label: t('settings.general'), description: t('settings.generalDescription') },
    paths: { label: t('settings.paths'), description: t('settings.pathsDescription') },
    steam: { label: t('settings.history'), description: t('settings.historyDescription') },
    video: { label: t('settings.video'), description: t('settings.videoDescription') },
    analysis: { label: t('settings.analysis'), description: t('settings.analysisDescription') },
    recording: { label: t('settings.recording'), description: t('settings.recordingDescription') },
  } satisfies Record<SettingsTab, { label: string; description: string }>;
  const [tab, setTab] = useState<SettingsTab>('general');
  const [config, setConfig] = useState<AppConfig>(defaultConfig);
  const [savedConfig, setSavedConfig] = useState<AppConfig | null>(null);
  const [source, setSource] = useState<SettingsSource>('loading');
  const [loadError, setLoadError] = useState<string | null>(null);
  const theme = useUiStore((state) => state.theme);
  const setTheme = useUiStore((state) => state.setTheme);
  const language = useUiStore((state) => state.language);
  const [draftTheme, setDraftTheme] = useState(theme);
  const [draftLanguage, setDraftLanguage] = useState(language);
  const saveAction = useAsyncAction<AppConfig>();

  useEffect(() => {
    const controller = new AbortController();
    void commands.getConfig(controller.signal)
      .then((response) => {
        setConfig(response);
        setSavedConfig(response);
        setSource('service');
        if (response.locale === 'zh-CN' || response.locale === 'en-US') applyLocale(response.locale);
        if (response.theme === 'dark' || response.theme === 'light' || response.theme === 'system') setTheme(response.theme);
        if (response.locale === 'zh-CN' || response.locale === 'en-US') setDraftLanguage(response.locale);
        if (response.theme === 'dark' || response.theme === 'light' || response.theme === 'system') setDraftTheme(response.theme);
      })
      .catch((error: unknown) => {
        setSource('unavailable');
        setLoadError(readableError(error));
      });
    return () => controller.abort();
  }, [setTheme]);

  const save = async () => {
    const payload = { ...config, locale: draftLanguage, theme: draftTheme };
    const result = await saveAction.run(() => commands.updateConfig(payload), msg("m1116"));
    if (result) {
      setConfig(result);
      setSavedConfig(result);
      applyLocale(result.locale === 'en-US' ? 'en-US' : 'zh-CN');
      setTheme(result.theme === 'light' || result.theme === 'system' ? result.theme : 'dark');
    }
  };

  const updateObs = <K extends keyof AppConfig['obs']>(key: K, value: AppConfig['obs'][K]) =>
    setConfig((current) => ({ ...current, obs: { ...current.obs, [key]: value } }));
  const updateLlm = <K extends keyof AppConfig['llm']>(key: K, value: AppConfig['llm'][K]) =>
    setConfig((current) => ({
      ...current,
      clear_llm_api_key: key === 'api_key' && String(value).trim() ? false : current.clear_llm_api_key,
      llm: { ...current.llm, [key]: value },
    }));
  const clearLlmApiKey = () => setConfig((current) => ({
    ...current,
    llm: { ...current.llm, api_key: '' },
    llm_has_api_key: false,
    clear_llm_api_key: true,
  }));
  const updateSteam = <K extends keyof AppConfig['steam']>(key: K, value: AppConfig['steam'][K]) =>
    setConfig((current) => ({ ...current, steam: { ...current.steam, [key]: value } }));
  const updateRecording = <K extends keyof AppConfig['recording']>(key: K, value: AppConfig['recording'][K]) =>
    setConfig((current) => ({ ...current, recording: { ...current.recording, [key]: value } }));

  return (
    <div className="page page--settings">
      <PageHeader
        eyebrow="PREFERENCES"
        title={t('settings.title')}
        description={t('settings.description')}
        actions={<Button variant="primary" disabled={source !== 'service' || saveAction.state.status === 'loading'} onClick={() => void save()}>{saveAction.state.status === 'loading' ? <Spinner /> : <Save size={15} />}{t('settings.save')}</Button>}
      />

      {source !== 'service' ? <Notice tone={source === 'loading' ? 'info' : 'warning'} title={source === 'loading' ? t('common.loading') : t('common.unavailable')}>{source === 'loading' ? t('settings.loading') : loadError ?? t('settings.notConnected')}</Notice> : null}
      {saveAction.state.message ? <Notice tone={saveAction.state.status === 'error' ? 'danger' : 'success'}>{saveAction.state.message}</Notice> : null}

      <div className="settings-layout">
        <aside className="settings-nav">
          {settingsTabs.map(({ id, icon: Icon }) => <button type="button" key={id} className={tab === id ? 'is-active' : undefined} onClick={() => setTab(id)}><span className="settings-nav__icon"><Icon size={16} /></span><span><strong>{tabCopy[id].label}</strong><small>{tabCopy[id].description}</small></span><ChevronRight size={14} /></button>)}
          <div className="settings-nav__status"><span className={`status-dot status-dot--${source === 'service' ? 'online' : 'idle'}`} /><div><strong>{t('settings.localService')}</strong><small>{source === 'service' ? t('settings.connected') : t('settings.disconnected')}</small></div></div>
        </aside>

        <section className="settings-content">
          {tab === 'general' ? <><GeneralSettings theme={draftTheme} language={draftLanguage} setTheme={setDraftTheme} setLanguage={setDraftLanguage} config={config} /><ProductSettings config={config} savedManifestUrl={savedConfig?.update_manifest_url ?? ''} source={source} setConfig={setConfig} /></> : null}
          {tab === 'paths' ? <PathSettings config={config} setConfig={setConfig} /> : null}
          {tab === 'steam' ? <SteamSettings config={config} setConfig={setConfig} updateSteam={updateSteam} /> : null}
          {tab === 'video' ? <VideoSettings config={config} savedConfig={savedConfig} source={source} setConfig={setConfig} updateObs={updateObs} /> : null}
          {tab === 'analysis' ? <AnalysisSettings config={config} source={source} updateLlm={updateLlm} clearLlmApiKey={clearLlmApiKey} /> : null}
          {tab === 'recording' ? <RecordingSettings config={config} updateRecording={updateRecording} /> : null}
        </section>
      </div>
    </div>
  );
}

function SteamSettings({ config, setConfig, updateSteam }: { config: AppConfig; setConfig: React.Dispatch<React.SetStateAction<AppConfig>>; updateSteam: <K extends keyof AppConfig['steam']>(key: K, value: AppConfig['steam'][K]) => void }) {
  const testAction = useAsyncAction<unknown>();
  const disconnectAction = useAsyncAction<{ disconnected: boolean }>();
  const canTest = config.steam.steam_id.length === 17
    && (Boolean(config.steam.web_api_key.trim()) || config.steam_has_web_api_key)
    && (Boolean(config.steam.authentication_code.trim()) || config.steam_has_authentication_code)
    && (Boolean(config.steam.known_share_code.trim()) || config.steam_has_share_code);
  const disconnect = async () => {
    const result = await disconnectAction.run(() => commands.disconnectMatchHistory(), msg("m0073"));
    if (!result) return;
    setConfig((current) => ({
      ...current,
      steam: { steam_id: '', web_api_key: '', authentication_code: '', known_share_code: '', maximum_results: 20 },
      steam_has_web_api_key: false,
      steam_has_authentication_code: false,
      steam_has_share_code: false,
    }));
  };

  return (
    <div className="settings-stack-page">
      <SettingsSection eyebrow="STEAM MATCH HISTORY" title={msg("m1211")} description={msg("m0788")}>
        <Notice tone="info">{msg("m1289")}</Notice>
        <Field label="Steam ID 64" hint={msg("m0616")}><TextInput value={config.steam.steam_id} onChange={(event) => updateSteam('steam_id', event.target.value.replace(/\D/g, '').slice(0, 17))} inputMode="numeric" placeholder="7656119…" /></Field>
        <Field label="Steam Web API Key" hint={config.steam_has_web_api_key ? msg("m0493") : msg("m0187")}><TextInput type="password" value={config.steam.web_api_key} onChange={(event) => updateSteam('web_api_key', event.target.value)} autoComplete="new-password" placeholder={config.steam_has_web_api_key ? msg("m0508") : msg("m0020")} /></Field>
        <Field label={msg("m0935")} hint={config.steam_has_authentication_code ? msg("m0491") : msg("m0829")}><TextInput type="password" value={config.steam.authentication_code} onChange={(event) => updateSteam('authentication_code', event.target.value)} autoComplete="new-password" placeholder={config.steam_has_authentication_code ? msg("m0508") : 'XXXX-XXXXX-XXXX'} /></Field>
        <Field label={msg("m0739")} hint={config.steam_has_share_code ? msg("m0356") : msg("m0828")}><TextInput type="password" value={config.steam.known_share_code} onChange={(event) => updateSteam('known_share_code', event.target.value)} autoComplete="new-password" placeholder={config.steam_has_share_code ? msg("m0357") : 'CSGO-…'} /></Field>
        <Field label={msg("m0313")}><div className="number-control"><input type="number" min="1" max="100" value={config.steam.maximum_results} onChange={(event) => updateSteam('maximum_results', Number(event.target.value))} /><span>{msg("m0400")}</span></div></Field>
        <div className="field-row">
          <Button disabled={!canTest || testAction.state.status === 'loading'} onClick={() => void testAction.run(() => commands.testMatchHistory(config.steam), msg("m0074"))}>{testAction.state.status === 'loading' ? <Spinner /> : <KeyRound size={14} />}{msg("m0908")}</Button>
          <Button variant="danger" disabled={disconnectAction.state.status === 'loading' || (!config.steam_has_web_api_key && !config.steam.web_api_key)} onClick={() => void disconnect()}>{disconnectAction.state.status === 'loading' ? <Spinner /> : <Unplug size={14} />}{msg("m0930")}</Button>
        </div>
        {testAction.state.message ? <Notice tone={testAction.state.status === 'error' ? 'danger' : 'success'}>{testAction.state.message}</Notice> : null}
        {disconnectAction.state.message ? <Notice tone={disconnectAction.state.status === 'error' ? 'danger' : 'success'}>{disconnectAction.state.message}</Notice> : null}
        <div className="privacy-note"><KeyRound size={14} /><span>{msg("m1258")}</span></div>
      </SettingsSection>
    </div>
  );
}

function SettingsSection({ eyebrow, title, description, children }: { eyebrow: string; title: string; description: string; children: React.ReactNode }) {
  return <Card className="settings-section"><header><span className="eyebrow">{eyebrow}</span><h2>{title}</h2><p>{description}</p></header><div className="settings-section__body">{children}</div></Card>;
}

function GeneralSettings({ theme, language, setTheme, setLanguage, config }: { theme: 'dark' | 'light' | 'system'; language: 'zh-CN' | 'en-US'; setTheme: (value: 'dark' | 'light' | 'system') => void; setLanguage: (value: 'zh-CN' | 'en-US') => void; config: AppConfig }) {
  const { t } = useI18n();
  const [storage, setStorage] = useState<StorageStatus | null>(null);
  const [storageError, setStorageError] = useState<string | null>(null);
  const [storageLoading, setStorageLoading] = useState(false);
  const cleanupAction = useAsyncAction<MediaProxyCleanup>();
  const refreshStorage = useCallback(async (signal?: AbortSignal) => {
    setStorageLoading(true);
    try {
      const response = await commands.storageStatus(signal);
      setStorage(response);
      setStorageError(null);
    } catch (error) {
      if (!signal?.aborted) setStorageError(readableError(error));
    } finally {
      if (!signal?.aborted) setStorageLoading(false);
    }
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    void refreshStorage(controller.signal);
    return () => controller.abort();
  }, [refreshStorage]);
  const occupiedBytes = storage
    ? Math.max(0, storage.filesystem_total_bytes - storage.filesystem_available_bytes)
    : 0;
  const occupiedPercent = storage && storage.filesystem_total_bytes > 0
    ? Math.min(100, occupiedBytes / storage.filesystem_total_bytes * 100)
    : 0;
  const cleanupProxies = async () => {
    const result = await cleanupAction.run(
      () => commands.cleanupMediaProxies(),
    );
    if (result) await refreshStorage();
  };
  return <div className="settings-stack-page"><SettingsSection eyebrow="APPEARANCE" title={t('settings.appearance')} description={t('settings.appearanceDescription')}><Field label={t('settings.theme')}><div className="theme-choice">{([{ value: 'dark', label: t('settings.dark'), icon: Moon }, { value: 'light', label: t('settings.light'), icon: Sun }, { value: 'system', label: t('settings.system'), icon: MonitorCog }] as const).map(({ value, label, icon: Icon }) => <button type="button" key={value} className={theme === value ? 'is-active' : undefined} onClick={() => setTheme(value)}><span><Icon size={17} /></span><strong>{label}</strong>{theme === value ? <Check size={14} /> : null}</button>)}</div></Field><Field label={t('settings.language')}><div className="language-choice"><button type="button" className={language === 'zh-CN' ? 'is-active' : undefined} onClick={() => setLanguage('zh-CN')}><Languages size={15} /><span><strong>{t('settings.chinese')}</strong><small>{msg("m0164")}</small></span>{language === 'zh-CN' ? <Check size={14} /> : null}</button><button type="button" className={language === 'en-US' ? 'is-active' : undefined} onClick={() => setLanguage('en-US')}><Languages size={15} /><span><strong>{t('settings.english')}</strong><small>English</small></span>{language === 'en-US' ? <Check size={14} /> : null}</button></div></Field></SettingsSection><SettingsSection eyebrow="LOCAL DATA" title={t('settings.dataDirectory')} description={msg("m0269")}><PathField icon={<Database size={15} />} label={t('settings.localData')} value={storage?.data_dir ?? config.data_dir} placeholder={msg("m0995")} /><div className="storage-meter"><div><span><HardDrive size={14} />{msg("m0802")}</span><strong>{storage ? `${formatBytes(occupiedBytes)} / ${formatBytes(storage.filesystem_total_bytes)}` : storageLoading ? msg("m0860") : msg("m0147")}</strong></div><div><i style={{ width: `${occupiedPercent}%` }} /></div><small>{storage ? msgf("m0555", [formatBytes(storage.directory_bytes), storage.file_count.toLocaleString(currentLocale()), storage.scan_complete ? '' : msg("m1338")]) : storageError ?? msg("m0871")}</small></div><div className="field-row"><Button size="sm" disabled={storageLoading} onClick={() => void refreshStorage()}>{storageLoading ? <Spinner /> : <RefreshCw size={13} />}{t('common.refresh')}</Button><Button variant="danger" size="sm" disabled={cleanupAction.state.status === 'loading'} onClick={() => void cleanupProxies()}>{cleanupAction.state.status === 'loading' ? <Spinner /> : <Trash2 size={13} />}{msg("m0923")}</Button></div>{cleanupAction.state.status === 'error' ? <Notice tone="danger">{cleanupAction.state.message}</Notice> : cleanupAction.state.status === 'success' ? <Notice tone={cleanupAction.state.data.failed_files.length > 0 ? 'warning' : 'success'}>{msg("m0499")} {cleanupAction.state.data.removed_files} {msg("m0153")} {formatBytes(cleanupAction.state.data.freed_bytes)}{msg("m1336")} {cleanupAction.state.data.skipped_generating} {msg("m0158")}{cleanupAction.state.data.failed_files.length > 0 ? msgf("m0001", [cleanupAction.state.data.failed_files.length]) : ''}</Notice> : null}</SettingsSection></div>;
}

function ProductSettings({ config, savedManifestUrl, source, setConfig }: { config: AppConfig; savedManifestUrl: string; source: SettingsSource; setConfig: React.Dispatch<React.SetStateAction<AppConfig>> }) {
  const { t } = useI18n();
  const desktop = isDesktopShell();
  const [updateInfo, setUpdateInfo] = useState<UpdateInfo | null>(null);
  const [locations, setLocations] = useState<ManagedLocations | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [updateResult, setUpdateResult] = useState<UpdateCheckResult | null>(null);
  const [checkedManifestUrl, setCheckedManifestUrl] = useState<string | null>(null);
  const [openMessage, setOpenMessage] = useState<string | null>(null);
  const updateControllerRef = useRef<AbortController | null>(null);
  const updateAction = useAsyncAction<UpdateCheckResult>();
  const diagnosticAction = useAsyncAction<{ path: string; created_at: string; contains_secrets: false }>();

  useEffect(() => {
    if (source !== 'service') return undefined;
    const controller = new AbortController();
    void Promise.allSettled([
      productApi.updateInfo(controller.signal),
      productApi.managedLocations(controller.signal),
    ]).then(([update, managed]) => {
      if (controller.signal.aborted) return;
      if (update.status === 'fulfilled') setUpdateInfo(update.value);
      if (managed.status === 'fulfilled') setLocations(managed.value);
      const error = update.status === 'rejected' ? update.reason : managed.status === 'rejected' ? managed.reason : null;
      setLoadError(error ? readableError(error) : null);
    });
    return () => controller.abort();
  }, [savedManifestUrl, source]);

  useEffect(() => {
    updateControllerRef.current?.abort();
    updateControllerRef.current = null;
    setUpdateResult(null);
    setCheckedManifestUrl(null);
    updateAction.reset();
    return () => updateControllerRef.current?.abort();
  }, [config.update_manifest_url, savedManifestUrl, source, updateAction.reset]);

  const manifestSaved = config.update_manifest_url.trim() === savedManifestUrl.trim()
    && updateInfo?.manifest_url === (savedManifestUrl.trim() || null);
  const canOpenUpdate = Boolean(
    updateResult?.update_available
    && manifestSaved
    && checkedManifestUrl === savedManifestUrl.trim(),
  );
  const checkUpdate = async () => {
    updateControllerRef.current?.abort();
    const controller = new AbortController();
    const manifestRevision = savedManifestUrl.trim();
    updateControllerRef.current = controller;
    const result = await updateAction.run(() => productApi.checkUpdate(controller.signal));
    if (result && !controller.signal.aborted && updateControllerRef.current === controller) {
      setUpdateResult(result);
      setCheckedManifestUrl(manifestRevision);
    }
    if (updateControllerRef.current === controller) updateControllerRef.current = null;
  };
  const openDirectory = async (path: string | undefined) => {
    if (!path || !desktop) {
      setOpenMessage(t('settings.desktopOnly'));
      return;
    }
    try {
      await openLocalDirectory(path);
      setOpenMessage(null);
    } catch (error) {
      setOpenMessage(readableError(error));
    }
  };
  const exportDiagnostics = async () => {
    const result = await diagnosticAction.run(() => productApi.exportDiagnostics());
    if (!result) return;
    if (desktop) {
      try {
        await revealLocalPath(result.path);
      } catch (error) {
        setOpenMessage(readableError(error));
      }
    }
  };
  const openDownload = async () => {
    if (!updateResult || !canOpenUpdate) return;
    try {
      const opened = await openExternalHttpsUrl(updateResult.download_url);
      if (!opened) setOpenMessage(t('settings.downloadRejected'));
    } catch (error) {
      setOpenMessage(readableError(error));
    }
  };

  return (
    <div className="settings-stack-page">
      <SettingsSection eyebrow="ABOUT" title={t('settings.about')} description={t('settings.aboutDescription')}>
        {loadError ? <Notice tone="warning">{loadError}</Notice> : null}
        <div className="feature-status"><span className="feature-status__icon"><Info size={16} /></span><div><strong>{t('settings.currentVersion')}</strong><small>{updateInfo?.current_version ?? '—'}</small></div><Badge tone="neutral">{updateInfo ? `v${updateInfo.current_version}` : t('common.loading')}</Badge></div>
        <Field label={t('settings.updateManifest')} hint={t('settings.updateManifestHint')}><TextInput value={config.update_manifest_url} onChange={(event) => setConfig((current) => ({ ...current, update_manifest_url: event.target.value }))} placeholder="https://updates.example.com/manifest.json" /></Field>
        {!manifestSaved && config.update_manifest_url.trim() ? <Notice tone="info">{t('settings.saveManifestFirst')}</Notice> : null}
        <div className="field-row">
          <Button disabled={source !== 'service' || !updateInfo?.configured || !manifestSaved || updateAction.state.status === 'loading'} onClick={() => void checkUpdate()}>{updateAction.state.status === 'loading' ? <Spinner /> : <RefreshCw size={13} />}{t('settings.checkUpdate')}</Button>
          <Button disabled={!canOpenUpdate} onClick={() => void openDownload()}><Download size={13} />{t('settings.openDownload')}</Button>
        </div>
        {updateAction.state.status === 'error' ? <Notice tone="danger">{updateAction.state.message}</Notice> : updateResult ? <Notice tone={updateResult.update_available ? 'info' : 'success'} title={updateResult.update_available ? t('settings.updateAvailable') : t('settings.noUpdate')}>{updateResult.update_available ? `v${updateResult.latest_version}${updateResult.notes ? ` · ${updateResult.notes}` : ''}` : `v${updateResult.current_version}`}</Notice> : null}
        <div className="field-row">
          <Button size="sm" disabled={!locations} onClick={() => void openDirectory(locations?.data)}><FolderOpen size={13} />{t('settings.openData')}</Button>
          <Button size="sm" disabled={!locations} onClick={() => void openDirectory(locations?.logs)}><FolderOpen size={13} />{t('settings.openLogs')}</Button>
          <Button size="sm" disabled={!locations} onClick={() => void openDirectory(locations?.exports)}><FolderOpen size={13} />{t('settings.openOutputs')}</Button>
          <Link className="button button--secondary button--sm" to="/recovery" title={t('settings.recoveryCenterDescription')}><ShieldCheck size={13} />{t('settings.recoveryCenter')}</Link>
          <Button size="sm" disabled={source !== 'service' || diagnosticAction.state.status === 'loading'} onClick={() => void exportDiagnostics()}>{diagnosticAction.state.status === 'loading' ? <Spinner /> : <FileJson size={13} />}{t('settings.exportDiagnostics')}</Button>
        </div>
        {!desktop ? <Notice tone="info">{t('settings.desktopOnly')}</Notice> : null}
        {openMessage ? <Notice tone="warning">{openMessage}</Notice> : null}
        {diagnosticAction.state.status === 'success' ? <Notice tone="success">{diagnosticAction.state.message ?? diagnosticAction.state.data.path}</Notice> : diagnosticAction.state.status === 'error' ? <Notice tone="danger">{diagnosticAction.state.message}</Notice> : null}
      </SettingsSection>
      <SettingsSection eyebrow="MIGRATION" title={t('settings.migration')} description={t('settings.migrationDescription')}>
        <Notice tone="info">VIBE_CS_PREVIOUS_DATA_DIR</Notice>
      </SettingsSection>
    </div>
  );
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'] as const;
  const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** exponent;
  return `${value.toFixed(exponent === 0 ? 0 : value >= 10 ? 1 : 2)} ${units[exponent] ?? 'TB'}`;
}

function PathSettings({ config, setConfig }: { config: AppConfig; setConfig: React.Dispatch<React.SetStateAction<AppConfig>> }) {
  const { t } = useI18n();
  const [newPath, setNewPath] = useState('');
  const detectAction = useAsyncAction<DetectedPaths>();
  const hlaeStatusAction = useAsyncAction<HlaeStatus>();
  const addWatchPaths = (paths: string[]) => {
    const normalized = paths.map((path) => path.trim()).filter(Boolean);
    if (normalized.length === 0) return;
    setConfig((current) => ({
      ...current,
      demo_watch_paths: [...new Set([...current.demo_watch_paths, ...normalized])],
    }));
  };
  const browseForWatchPaths = async () => {
    addWatchPaths(await chooseLocalDirectories({ title: msg("m1219"), multiple: true }));
  };
  const detectPaths = async () => {
    const detected = await detectAction.run(() => commands.detectPaths(), msg("m0511"));
    if (!detected) return;
    setConfig((current) => ({
      ...current,
      cs2_path: detected.cs2_path ?? current.cs2_path,
      hlae_path: detected.hlae_path ?? current.hlae_path,
      steam_path: detected.steam_path ?? current.steam_path,
      ffmpeg_path: detected.ffmpeg_path ?? current.ffmpeg_path,
      ffprobe_path: detected.ffprobe_path ?? current.ffprobe_path,
      obs: { ...current.obs, executable: detected.obs_path ?? current.obs.executable },
    }));
  };
  const checkHlae = async () => {
    await hlaeStatusAction.run(
      () => commands.checkHlaeStatus(config.hlae_path, config.cs2_path),
      msg("m0511"),
    );
  };

  return (
    <div className="settings-stack-page">
      <SettingsSection eyebrow="GAME INSTALLATION" title={msg("m0934")} description={msg("m0992")}>
        <Button size="sm" disabled={detectAction.state.status === 'loading'} onClick={() => void detectPaths()}>{detectAction.state.status === 'loading' ? <Spinner /> : <RefreshCw size={13} />}{msg("m1095")}</Button>
        {detectAction.state.message ? <Notice tone={detectAction.state.status === 'error' ? 'danger' : 'success'}>{detectAction.state.message}</Notice> : null}
        <PathField
          icon={<Gamepad2 size={15} />}
          label={msg("m0031")}
          value={config.cs2_path}
          onChange={(value) => setConfig((current) => ({ ...current, cs2_path: value }))}
          placeholder="C:\Program Files\...\cs2.exe"
          browse={{ kind: 'file', title: msg("m1217"), filters: [{ name: msg("m0081"), extensions: ['exe'] }] }}
        />
        <PathField
          icon={<Clapperboard size={15} />}
          label="HLAE"
          value={config.hlae_path}
          onChange={(value) => setConfig((current) => ({ ...current, hlae_path: value }))}
          placeholder="C:\\HLAE\\HLAE.exe"
          browse={{ kind: 'file', title: t('settings.chooseHlae'), filters: [{ name: 'HLAE', extensions: ['exe'] }] }}
        />
        <div className="settings-inline-actions">
          <Button size="sm" variant="secondary" disabled={hlaeStatusAction.state.status === 'loading'} onClick={() => void checkHlae()}>
            {hlaeStatusAction.state.status === 'loading' ? <Spinner /> : <ShieldCheck size={13} />}{t('settings.checkHlae')}
          </Button>
          {hlaeStatusAction.state.data ? (
            <Badge tone={hlaeStatusAction.state.data.available ? 'success' : 'warning'}>
              {hlaeStatusAction.state.data.available ? t('settings.hlaeReady') : t('settings.hlaeMissing')}
            </Badge>
          ) : null}
        </div>
        {hlaeStatusAction.state.data ? (
          <Notice tone={hlaeStatusAction.state.data.launch_profile_ready ? 'info' : 'warning'}>
            {hlaeStatusAction.state.data.executable ?? hlaeStatusAction.state.data.messages[0]}
            {' · '}{t('settings.hlaeSafety')}
          </Notice>
        ) : hlaeStatusAction.state.message ? (
          <Notice tone="danger">{hlaeStatusAction.state.message}</Notice>
        ) : null}
        <PathField
          icon={<Server size={15} />}
          label={msg("m0075")}
          value={config.steam_path}
          onChange={(value) => setConfig((current) => ({ ...current, steam_path: value }))}
          placeholder="C:\Program Files (x86)\Steam"
          browse={{ kind: 'directory', title: msg("m1225") }}
        />
      </SettingsSection>
      <SettingsSection eyebrow="WATCH FOLDERS" title={msg("m0037")} description={msg("m0642")}>
        <div className="path-list">
          {config.demo_watch_paths.length === 0
            ? <div className="path-list__empty"><FolderCog size={18} />{msg("m1199")}</div>
            : config.demo_watch_paths.map((path) => (
              <div key={path}>
                <FileVideo2 size={15} />
                <span>{path}</span>
                <button type="button" aria-label={msgf("m1049", [path])} onClick={() => setConfig((current) => ({ ...current, demo_watch_paths: current.demo_watch_paths.filter((item) => item !== path) }))}><Trash2 size={13} /></button>
              </div>
            ))}
        </div>
        <div className="add-path">
          <TextInput value={newPath} onChange={(event) => setNewPath(event.target.value)} placeholder={msg("m1181")} />
          <Button disabled={!newPath.trim()} onClick={() => { addWatchPaths([newPath]); setNewPath(''); }}>{msg("m0920")}</Button>
          <Button disabled={!isDesktopShell()} title={isDesktopShell() ? msg("m1227") : msg("m1139")} onClick={() => void browseForWatchPaths()}>{msg("m0914")}</Button>
        </div>
      </SettingsSection>
    </div>
  );
}

type ObsDiagnosisState =
  | { status: 'idle'; data: null; message: null }
  | { status: 'loading'; data: null; message: null }
  | { status: 'success'; data: ObsDiagnosis; message: null }
  | { status: 'error'; data: null; message: string };

export function VideoSettings({
  config,
  savedConfig,
  source,
  setConfig,
  updateObs,
}: {
  config: AppConfig;
  savedConfig: AppConfig | null;
  source: SettingsSource;
  setConfig: React.Dispatch<React.SetStateAction<AppConfig>>;
  updateObs: <K extends keyof AppConfig['obs']>(key: K, value: AppConfig['obs'][K]) => void;
}) {
  const { t } = useI18n();
  const dependencyAction = useAsyncAction<QuickCheckResponse>();
  const mediaRuntimeAction = useAsyncAction<MediaRuntimeStatus>();
  const testAction = useAsyncAction<ObsRecordStatus>();
  const launchAction = useAsyncAction<{ started: boolean; process_id: number }>();
  const diagnosisController = useRef<AbortController | null>(null);
  const [diagnosisState, setDiagnosisState] = useState<ObsDiagnosisState>({
    status: 'idle',
    data: null,
    message: null,
  });
  const hasUnsavedRuntimeSettings = savedConfig
    ? hasUnsavedObsRuntimeSettings(config, savedConfig)
    : false;
  const savedObsConfigured = Boolean(savedConfig?.obs.host.trim() && savedConfig.obs.port > 0);
  const savedExecutableConfigured = Boolean(savedConfig?.obs.executable.trim());

  useEffect(() => {
    if (source === 'service') {
      void mediaRuntimeAction.run(() => commands.mediaRuntimeStatus());
    } else {
      mediaRuntimeAction.reset();
    }
  }, [mediaRuntimeAction.reset, mediaRuntimeAction.run, source]);

  const refreshDiagnosis = useCallback(async (retryAfterLaunch = false) => {
    diagnosisController.current?.abort();
    if (source !== 'service') {
      setDiagnosisState({ status: 'idle', data: null, message: null });
      return;
    }

    const controller = new AbortController();
    diagnosisController.current = controller;
    setDiagnosisState({ status: 'loading', data: null, message: null });
    try {
      const response = retryAfterLaunch
        ? await retryObsDiagnosis(commands.diagnoseObs, { signal: controller.signal })
        : await commands.diagnoseObs(controller.signal);
      if (!controller.signal.aborted) {
        setDiagnosisState({ status: 'success', data: response, message: null });
      }
    } catch (error) {
      if (!controller.signal.aborted) {
        setDiagnosisState({ status: 'error', data: null, message: readableError(error) });
      }
    }
  }, [source]);

  useEffect(() => {
    if (source === 'service' && savedConfig) void refreshDiagnosis();
    return () => diagnosisController.current?.abort();
  }, [refreshDiagnosis, savedConfig, source]);

  const launchObs = async () => {
    const result = await launchAction.run(
      () => commands.startObs(),
      msg("m0050"),
    );
    if (result) await refreshDiagnosis(true);
  };

  return (
    <div className="settings-stack-page">
      <SettingsSection eyebrow="MEDIA TOOLCHAIN" title={t('settings.mediaRuntime')} description={t('settings.mediaRuntimeDescription')}>
        {mediaRuntimeAction.state.status === 'loading' ? <Notice tone="info"><Spinner />{msg("m0872")}</Notice> : null}
        {mediaRuntimeAction.state.status === 'success' ? <Notice tone="success">{t('settings.mediaRuntimeManaged')}</Notice> : null}
        {mediaRuntimeAction.state.status === 'error' ? <Notice tone="danger">{mediaRuntimeAction.state.message}</Notice> : null}
        {mediaRuntimeAction.state.status === 'success' ? <div className="dependency-inline"><span className="setup-row__icon"><FilmIcon /></span><div><strong>{mediaRuntimeAction.state.data.backend}</strong><small>libavcodec {mediaRuntimeAction.state.data.version} · {mediaRuntimeAction.state.data.license}</small></div><Badge tone="success">Native</Badge></div> : null}
        {mediaRuntimeAction.state.status === 'success' ? <Notice tone="info">{t('settings.encoderAvailable')}: {mediaRuntimeAction.state.data.encoders.join(', ')}</Notice> : null}
        <Field label={msg("m1324")} hint={t('settings.encoderDescription')}><select value={config.preferred_encoder} onChange={(event) => setConfig((current) => ({ ...current, preferred_encoder: event.target.value as AppConfig['preferred_encoder'] }))}><option value="auto">{msg("m1096")}</option><option value="libopenh264">OpenH264 (CPU)</option><option value="h264_mf">Media Foundation</option><option value="h264_nvenc">NVIDIA NVENC</option><option value="h264_qsv">Intel Quick Sync</option><option value="h264_amf">AMD AMF</option></select></Field>
        <div className="dependency-inline"><span className="setup-row__icon setup-row__icon--warning"><CircleAlert size={14} /></span><div><strong>{msg("m0204")}</strong><small>{msg("m0744")}</small></div><Button size="sm" disabled={dependencyAction.state.status === 'loading'} onClick={() => void dependencyAction.run(() => commands.quickCheck(), msg("m0205"))} >{dependencyAction.state.status === 'loading' ? <Spinner /> : <RefreshCw size={13} />}{msg("m0830")}</Button></div>
        {dependencyAction.state.message ? <Notice tone={dependencyAction.state.status === 'error' ? 'danger' : 'success'}>{dependencyAction.state.message}</Notice> : null}
      </SettingsSection>
      <SettingsSection eyebrow="OBS WEBSOCKET" title={msg("m0048")} description={msg("m1212")}>
        {source !== 'service' ? <Notice tone="warning" title={msg("m0769")}>{msg("m0912")}</Notice> : null}
        {source === 'service' && !isDesktopShell() ? <Notice tone="info">{msg("m0575")}</Notice> : null}
        {hasUnsavedRuntimeSettings ? <Notice tone="warning" title={msg("m0438")}>{msg("m0143")}</Notice> : null}
        <PathField icon={<Video size={15} />} label={msg("m0049")} value={config.obs.executable} onChange={(value) => updateObs('executable', value)} placeholder={msg("m0086")} browse={{ kind: 'file', title: msg("m1222"), filters: [{ name: msg("m0081"), extensions: ['exe'] }] }} />
        <div className="field-row"><Field label={msg("m0167")}><TextInput value={config.obs.host} onChange={(event) => updateObs('host', event.target.value)} /></Field><Field label={msg("m1057")}><TextInput type="number" value={config.obs.port} onChange={(event) => updateObs('port', Number(event.target.value))} /></Field></div>
        <Field label={msg("m0449")} hint={config.obs_has_password && !config.obs.password ? msg("m0492") : msg("m0450")}><TextInput type="password" value={config.obs.password} onChange={(event) => updateObs('password', event.target.value)} autoComplete="new-password" placeholder={config.obs_has_password ? msg("m0508") : undefined} /></Field>
        <Field label={msg("m0596")} hint={msg("m1208")}><TextInput value={config.obs.scene} onChange={(event) => updateObs('scene', event.target.value)} placeholder="Capture" /></Field>
        <div className="field-row obs-control-actions">
          <Button disabled={source !== 'service' || !config.obs.host.trim() || config.obs.port <= 0 || testAction.state.status === 'loading'} onClick={() => void testAction.run(() => commands.testObs(config.obs), msg("m0587"))}>{testAction.state.status === 'loading' ? <Spinner /> : <PlugZap size={14} />}{msg("m0908")}</Button>
          <Button variant="primary" disabled={source !== 'service' || hasUnsavedRuntimeSettings || !savedExecutableConfigured || launchAction.state.status === 'loading'} title={hasUnsavedRuntimeSettings ? msg("m1131") : savedExecutableConfigured ? msg("m0203") : msg("m1130")} onClick={() => void launchObs()}>{launchAction.state.status === 'loading' ? <Spinner /> : <Video size={14} />}{msg("m0363")}</Button>
        </div>
        {testAction.state.message ? <Notice tone={testAction.state.status === 'error' ? 'danger' : 'success'}>{testAction.state.message}</Notice> : null}
        {launchAction.state.message ? <Notice tone={launchAction.state.status === 'error' ? 'danger' : 'success'}>{launchAction.state.message}</Notice> : null}
        <div className="obs-diagnosis-heading">
          <div><strong>{msg("m0447")}</strong><small>{msg("m0402")}</small></div>
          <Button size="sm" disabled={source !== 'service' || !savedObsConfigured || diagnosisState.status === 'loading'} onClick={() => void refreshDiagnosis()}>{diagnosisState.status === 'loading' ? <Spinner /> : <RefreshCw size={13} />}{msg("m0295")}</Button>
        </div>
        {diagnosisState.status === 'success' ? <ObsDiagnosisDetails diagnosis={diagnosisState.data} selectedScene={config.obs.scene} expectedResolution={savedConfig?.recording.resolution ?? config.recording.resolution} expectedFps={savedConfig?.recording.fps ?? config.recording.fps} onSelectScene={(scene) => updateObs('scene', scene)} /> : null}
        {diagnosisState.status === 'loading' ? <Notice tone="info">{msg("m0875")}</Notice> : null}
        {diagnosisState.status === 'error' ? <Notice tone="danger" title={msg("m0060")}>{diagnosisState.message}</Notice> : null}
        {diagnosisState.status === 'idle' && source === 'service' ? <Notice tone="info">{msg("m0209")}</Notice> : null}
        <ObsTuningSection
          serviceAvailable={source === 'service'}
          serviceLoading={source === 'loading'}
          savedConfigAvailable={savedConfig !== null}
          savedObsConfigured={savedObsConfigured}
          hasUnsavedRuntimeSettings={hasUnsavedRuntimeSettings}
        />
      </SettingsSection>
    </div>
  );
}

export function ObsDiagnosisDetails({
  diagnosis,
  selectedScene,
  expectedResolution,
  expectedFps,
  onSelectScene,
}: {
  diagnosis: ObsDiagnosis;
  selectedScene: string;
  expectedResolution: string;
  expectedFps: number;
  onSelectScene: (scene: string) => void;
}) {
  const sceneMissing = Boolean(selectedScene && !diagnosis.scenes.scenes.includes(selectedScene));
  const unavailableDependencies = diagnosis.dependencies.dependencies.filter((item) => !item.available);
  return (
    <div className="obs-diagnosis" aria-label={msg("m0051")}>
      <div className="obs-diagnostic-grid">
        <div><span>{msg("m1207")}</span><strong>{msg("m0080")}</strong><Badge tone="success">{msg("m0394")}</Badge></div>
        <div><span>{msg("m0592")}</span><strong>{diagnosis.recording.active ? diagnosis.recording.paused ? msg("m0520") : msg("m0848") : msg("m0754")}</strong><Badge tone={diagnosis.recording.active ? 'warning' : 'neutral'}>{diagnosis.recording.active ? diagnosis.recording.timecode ?? msg("m0907") : msg("m1051")}</Badge></div>
        <div><span>{msg("m1191")}</span><strong>{diagnosis.video.output_width} × {diagnosis.video.output_height}</strong><Badge tone={diagnosis.resolution_matches ? 'success' : 'warning'}>{diagnosis.resolution_matches ? msg("m0310") : msgf("m0749", [expectedResolution])}</Badge></div>
        <div><span>{msg("m1189")}</span><strong>{formatObsFrameRate(diagnosis.video)}</strong><Badge tone={diagnosis.fps_matches ? 'success' : 'warning'}>{diagnosis.fps_matches ? msg("m0310") : msgf("m0750", [expectedFps])}</Badge></div>
      </div>
      <div className="field-row obs-scene-row">
        <Field label={msg("m0446")} hint={msgf("m0054", [diagnosis.scenes.current_program_scene])}>
          <select value={selectedScene} onChange={(event) => onSelectScene(event.target.value)}>
            <option value="">{msg("m0760")}</option>
            {sceneMissing ? <option value={selectedScene}>{selectedScene}{msg("m1332")}</option> : null}
            {diagnosis.scenes.scenes.map((scene) => <option key={scene} value={scene}>{scene}{scene === diagnosis.scenes.current_program_scene ? msg("m1334") : ''}</option>)}
          </select>
        </Field>
        <div className="obs-saved-scene"><span>{msg("m0489")}</span><strong>{diagnosis.configured_scene || msg("m0759")}</strong><Badge tone={diagnosis.scene_ready ? 'success' : 'warning'}>{diagnosis.scene_ready ? msg("m0350") : msg("m1287")}</Badge></div>
      </div>
      {diagnosis.warnings.length > 0 ? <Notice tone="warning" title={msg("m1121")}>{diagnosis.warnings.join('；')}</Notice> : <Notice tone="success">{msg("m0488")}</Notice>}
      {unavailableDependencies.length > 0 ? <Notice tone="warning" title={msg("m0806")}>{unavailableDependencies.map((item) => msgf("m0121", [item.name, item.message ?? msg("m0147")])).join(msg("m1339"))}</Notice> : null}
    </div>
  );
}

function AnalysisSettings({ config, source, updateLlm, clearLlmApiKey }: { config: AppConfig; source: SettingsSource; updateLlm: <K extends keyof AppConfig['llm']>(key: K, value: AppConfig['llm'][K]) => void; clearLlmApiKey: () => void }) {
  const llmAction = useAsyncAction<LlmTestResult>();
  const cleanupAction = useAsyncAction<ReplayCacheCleanup>();
  const [cacheStatus, setCacheStatus] = useState<ReplayCacheStatus | null>(null);
  const [cacheError, setCacheError] = useState<string | null>(null);
  const [cacheLoading, setCacheLoading] = useState(false);
  const [cacheRefresh, setCacheRefresh] = useState(0);
  const canTest = Boolean(
    config.llm.provider.trim()
    && config.llm.model.trim()
    && config.llm.base_url.trim()
    && (config.llm.api_key.trim() || config.llm_has_api_key),
  );

  useEffect(() => {
    if (source !== 'service') {
      setCacheStatus(null);
      setCacheError(source === 'unavailable' ? msg("m0792") : null);
      return undefined;
    }
    const controller = new AbortController();
    let active = true;
    setCacheLoading(true);
    setCacheError(null);
    void commands.replayCacheStatus(controller.signal)
      .then((status) => {
        if (active) setCacheStatus(status);
      })
      .catch((error: unknown) => {
        if (active && !controller.signal.aborted) setCacheError(readableError(error));
      })
      .finally(() => {
        if (active) setCacheLoading(false);
      });
    return () => {
      active = false;
      controller.abort();
    };
  }, [cacheRefresh, source]);

  const clearCache = async () => {
    const result = await cleanupAction.run(() => commands.clearReplayCache(), msg("m0019"));
    if (result) setCacheRefresh((value) => value + 1);
  };

  return (
    <div className="settings-stack-page">
      <SettingsSection eyebrow="LOCAL ANALYSIS" title={msg("m0803")} description={msg("m0405")}>
        <div className="feature-status"><span className="feature-status__icon"><Check size={16} /></span><div><strong>{msg("m0804")}</strong><small>{msg("m0032")}</small></div><Badge tone="success">{msg("m1329")}</Badge></div>
        <div className="feature-status"><span className="feature-status__icon">{cacheLoading ? <Spinner /> : <Check size={16} />}</span><div><strong>{msg("m0018")}</strong><small>{cacheStatus ? msgf("m0113", [cacheStatus.entries.toLocaleString(currentLocale()), formatBytes(cacheStatus.bytes), formatBytes(cacheStatus.maximum_bytes), cacheStatus.version, cacheStatus.scan_complete ? '' : msg("m1340")]) : cacheError ?? msg("m0872")}</small></div><Badge tone={cacheError || cacheStatus?.scan_complete === false ? 'warning' : cacheStatus ? 'success' : 'neutral'}>{cacheStatus ? msg("m0350") : cacheError ? msg("m0147") : msg("m1149")}</Badge></div>
        <div className="field-row"><Button size="sm" disabled={source !== 'service' || cacheLoading} onClick={() => setCacheRefresh((value) => value + 1)}>{cacheLoading ? <Spinner /> : <RefreshCw size={13} />}{msg("m0293")}</Button><Button size="sm" variant="danger" disabled={source !== 'service' || cleanupAction.state.status === 'loading'} onClick={() => void clearCache()}>{cleanupAction.state.status === 'loading' ? <Spinner /> : <Trash2 size={13} />}{msg("m0925")}</Button></div>
        {cleanupAction.state.status === 'success' ? <Notice tone={cleanupAction.state.data.failed_entries > 0 || !cleanupAction.state.data.scan_complete ? 'warning' : 'success'}>{msg("m0499")} {cleanupAction.state.data.removed_entries.toLocaleString(currentLocale())} {msg("m1309")} {formatBytes(cleanupAction.state.data.freed_bytes)}。{cleanupAction.state.data.failed_entries > 0 ? msgf("m0002", [cleanupAction.state.data.failed_entries.toLocaleString(currentLocale())]) : ''}{cleanupAction.state.data.scan_complete ? '' : msg("m0012")}</Notice> : cleanupAction.state.status === 'error' ? <Notice tone="danger">{cleanupAction.state.message}</Notice> : null}
      </SettingsSection>
      <SettingsSection eyebrow="OPTIONAL ASSISTANCE" title={msg("m1179")} description={msg("m0340")}>
        <Notice tone="info">{msg("m0150")}</Notice>
        <div className="field-row"><Field label={msg("m0664")}><select value={config.llm.provider} onChange={(event) => updateLlm('provider', event.target.value)}><option value="">{msg("m0772")}</option><option value="kimi-code">Kimi Code</option><option value="openai-compatible">{msg("m0066")}</option><option value="local">{msg("m0796")}</option></select></Field><Field label={msg("m0834")}><TextInput value={config.llm.model} onChange={(event) => updateLlm('model', event.target.value)} placeholder={msg("m0835")} /></Field></div>
        <Field label={msg("m0745")} hint={config.llm.provider === 'local' ? msg("m0785") : msg("m1206")}><TextInput value={config.llm.base_url} onChange={(event) => updateLlm('base_url', event.target.value)} placeholder={config.llm.provider === 'local' ? 'http://127.0.0.1:11434/v1' : 'https://.../v1'} /></Field>
        <Field label={msg("m0024")} hint={config.llm_has_api_key ? msg("m0493") : undefined}><TextInput type="password" value={config.llm.api_key} onChange={(event) => updateLlm('api_key', event.target.value)} autoComplete="new-password" placeholder={config.llm_has_api_key ? msg("m0508") : undefined} /></Field>
        <div className="field-row"><Button disabled={!canTest || llmAction.state.status === 'loading'} onClick={() => void llmAction.run(() => commands.testLlm(config.llm), msg("m1180"))}>{llmAction.state.status === 'loading' ? <Spinner /> : <Radio size={14} />}{msg("m0909")}</Button><Button variant="danger" disabled={!config.llm_has_api_key && !config.llm.api_key} onClick={clearLlmApiKey}><Trash2 size={14} />{msg("m0930")}</Button></div>
        {llmAction.state.message ? <Notice tone={llmAction.state.status === 'error' ? 'danger' : 'success'}>{llmAction.state.message}</Notice> : null}
        {llmAction.state.status === 'success' ? (
          <Notice tone="success">
            {llmAction.state.data.provider} · {llmAction.state.data.model} · Chat / Stream / Tools
          </Notice>
        ) : null}
      </SettingsSection>
    </div>
  );
}

function RecordingSettings({ config, updateRecording }: { config: AppConfig; updateRecording: <K extends keyof AppConfig['recording']>(key: K, value: AppConfig['recording'][K]) => void }) {
  return (
    <div className="settings-stack-page">
      <SettingsSection eyebrow="CLIP PACING" title={msg("m0967")} description={msg("m0693")}>
        <div className="field-row"><Field label={msg("m0297")}><div className="number-control"><input type="number" min="0" max="15" step="0.5" value={config.recording.pre_roll_seconds} onChange={(event) => updateRecording('pre_roll_seconds', Number(event.target.value))} /><span>{msg("m1044")}</span></div></Field><Field label={msg("m0361")}><div className="number-control"><input type="number" min="0" max="15" step="0.5" value={config.recording.post_roll_seconds} onChange={(event) => updateRecording('post_roll_seconds', Number(event.target.value))} /><span>{msg("m1044")}</span></div></Field><Field label={msg("m1174")}><div className="number-control"><input type="number" min="0" max="2" step="0.05" value={config.recording.transition_seconds} onChange={(event) => updateRecording('transition_seconds', Number(event.target.value))} /><span>{msg("m1044")}</span></div></Field></div>
      </SettingsSection>
      <SettingsSection eyebrow="CAPTURE DEFAULTS" title={msg("m0997")} description={msg("m0448")}>
        <Notice tone="info">{msg("m0620")}</Notice>
        <div className="field-row"><Field label={msg("m0275")}><select value={config.recording.resolution} onChange={(event) => updateRecording('resolution', event.target.value)}><option value="1920x1080">1920 × 1080</option><option value="2560x1440">2560 × 1440</option><option value="3840x2160">3840 × 2160</option></select></Field><Field label={msg("m0549")}><select value={config.recording.fps} onChange={(event) => updateRecording('fps', Number(event.target.value))}><option value="30">30 FPS</option><option value="60">60 FPS</option></select></Field></div>
        <div className="toggle-list">
          <label><span><Gamepad2 size={15} /><span><strong>{msg("m0600")}</strong><small>{msg("m0594")}</small></span></span><input type="checkbox" checked={config.recording.show_radar} onChange={(event) => updateRecording('show_radar', event.target.checked)} /></label>
          <label><span><Gamepad2 size={15} /><span><strong>{msg("m0198")}</strong><small>{msg("m0615")}</small></span></span><input type="checkbox" checked={config.recording.radar_restore_visible} onChange={(event) => updateRecording('radar_restore_visible', event.target.checked)} /></label>
          <label><span><MonitorCog size={15} /><span><strong>{msg("m0657")}</strong><small>{msg("m0697")}</small></span></span><input type="checkbox" checked={config.recording.show_keyboard} onChange={(event) => updateRecording('show_keyboard', event.target.checked)} /></label>
          <label><span><Radio size={15} /><span><strong>{msg("m0601")}</strong><small>{msg("m0196")}</small></span></span><input type="checkbox" checked={config.recording.mute_voice} onChange={(event) => { updateRecording('mute_voice', event.target.checked); if (event.target.checked) updateRecording('isolate_target_voice', false); }} /></label>
        </div>
        {config.recording.mute_voice ? <Field label={msg("m0197")} hint={msg("m0614")}><div className="number-control"><input type="number" min="0" max="100" step="5" value={Math.round(config.recording.voice_restore_volume * 100)} onChange={(event) => { const percent = Number(event.target.value); if (Number.isFinite(percent)) updateRecording('voice_restore_volume', Math.min(100, Math.max(0, percent)) / 100); }} /><span>%</span></div></Field> : null}
      </SettingsSection>
      <SettingsSection eyebrow="CAMERA PREHEAT" title={msg("m1061")} description={msg("m0881")}>
        <div className="field-row"><Field label={msg("m1274")}><div className="number-control"><input type="number" min="60" max="140" value={config.recording.camera_fov} onChange={(event) => updateRecording('camera_fov', Number(event.target.value))} /><span>°</span></div></Field><Field label={msg("m0626")}><div className="number-control"><input type="number" min="60" max="140" value={config.recording.camera_fov_restore} onChange={(event) => updateRecording('camera_fov_restore', Number(event.target.value))} /><span>°</span></div></Field></div>
        <div className="field-row"><Field label={msg("m0654")}><div className="number-control"><input type="number" min="54" max="68" value={config.recording.viewmodel_fov} onChange={(event) => updateRecording('viewmodel_fov', Number(event.target.value))} /><span>°</span></div></Field><Field label={msg("m0625")}><div className="number-control"><input type="number" min="54" max="68" value={config.recording.viewmodel_fov_restore} onChange={(event) => updateRecording('viewmodel_fov_restore', Number(event.target.value))} /><span>°</span></div></Field></div>
        <div className="field-row"><Field label={msg("m1278")}><div className="number-control"><input type="number" min="0" max="255" value={config.recording.flash_alpha} onChange={(event) => updateRecording('flash_alpha', Number(event.target.value))} /><span>/255</span></div></Field><Field label={msg("m0627")}><div className="number-control"><input type="number" min="0" max="255" value={config.recording.flash_alpha_restore} onChange={(event) => updateRecording('flash_alpha_restore', Number(event.target.value))} /><span>/255</span></div></Field></div>
        <div className="toggle-list">
          <label><span><Gamepad2 size={15} /><span><strong>{msg("m0729")}</strong><small>{msg("m0602")}</small></span></span><input type="checkbox" checked={config.recording.show_hud} onChange={(event) => updateRecording('show_hud', event.target.checked)} /></label>
          <label><span><Gamepad2 size={15} /><span><strong>{msg("m1080")}</strong><small>{msg("m0723")}</small></span></span><input type="checkbox" checked={config.recording.hud_restore_visible} onChange={(event) => updateRecording('hud_restore_visible', event.target.checked)} /></label>
          <label><span><Sparkles size={15} /><span><strong>{msg("m0728")}</strong><small>{msg("m0341")}</small></span></span><input type="checkbox" checked={config.recording.grenade_trajectory} onChange={(event) => updateRecording('grenade_trajectory', event.target.checked)} /></label>
          <label><span><Sparkles size={15} /><span><strong>{msg("m1079")}</strong><small>{msg("m0552")}</small></span></span><input type="checkbox" checked={config.recording.grenade_trajectory_restore} onChange={(event) => updateRecording('grenade_trajectory_restore', event.target.checked)} /></label>
          <label><span><Radio size={15} /><span><strong>{msg("m0339")}</strong><small>{msg("m0181")}</small></span></span><input type="checkbox" checked={config.recording.isolate_target_voice} onChange={(event) => { updateRecording('isolate_target_voice', event.target.checked); if (event.target.checked) updateRecording('mute_voice', false); }} /></label>
        </div>
      </SettingsSection>
      <SettingsSection eyebrow="USER ASSETS" title={msg("m1060")} description={msg("m0344")}>
        <PathField icon={<FolderCog size={15} />} label={msg("m0041")} value={config.recording.first_person_hud_assets} onChange={(value) => updateRecording('first_person_hud_assets', value)} placeholder={msg("m0309")} browse={{ kind: 'directory', title: msg("m1237") }} />
        <PathField icon={<FileVideo2 size={15} />} label={msg("m0065")} value={config.recording.obs_realtime_kill_fx_media} onChange={(value) => updateRecording('obs_realtime_kill_fx_media', value)} placeholder={msg("m1243")} browse={{ kind: 'file', title: msg("m1223"), filters: [{ name: msg("m1244"), extensions: ['webm', 'mov', 'mp4', 'png'] }] }} />
        <PathField icon={<FileVideo2 size={15} />} label={msg("m0055")} value={config.recording.obs_realtime_keyboard_media} onChange={(value) => updateRecording('obs_realtime_keyboard_media', value)} placeholder={msg("m0994")} browse={{ kind: 'file', title: msg("m1224"), filters: [{ name: msg("m0431"), extensions: ['webm', 'mov', 'mp4', 'png'] }] }} />
      </SettingsSection>
      <SettingsSection eyebrow="SYNC DIAGNOSTICS" title={msg("m0998")} description={msg("m1104")}>
        <Field label={msg("m0574")}><div className="number-control"><input type="number" min="-5000" max="5000" value={config.recording.capture_delay_ms} onChange={(event) => updateRecording('capture_delay_ms', Number(event.target.value))} /><span>ms</span></div></Field>
        <RecordingCalibrationPanel onApply={(delayMs) => updateRecording('capture_delay_ms', delayMs)} />
      </SettingsSection>
    </div>
  );
}

type PathBrowse =
  | { kind: 'file'; title: string; filters?: LocalDialogFilter[] }
  | { kind: 'directory'; title: string };

function PathField({
  icon,
  label,
  value,
  onChange,
  placeholder,
  browse,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  onChange?: (value: string) => void;
  placeholder: string;
  browse?: PathBrowse;
}) {
  const [browseError, setBrowseError] = useState<string | null>(null);
  const [browsing, setBrowsing] = useState(false);
  const desktop = isDesktopShell();

  const selectPath = async () => {
    if (!browse || !onChange || !desktop) return;
    setBrowseError(null);
    setBrowsing(true);
    try {
      const selected = browse.kind === 'file'
        ? await chooseLocalFile({ title: browse.title, ...(browse.filters ? { filters: browse.filters } : {}) })
        : (await chooseLocalDirectories({ title: browse.title, multiple: false }))[0] ?? null;
      if (selected) onChange(selected);
    } catch (error) {
      setBrowseError(readableError(error));
    } finally {
      setBrowsing(false);
    }
  };

  return (
    <Field label={label} hint={browseError ?? undefined}>
      <div className="path-input">
        <span>{icon}</span>
        <input value={value} onChange={(event) => onChange?.(event.target.value)} placeholder={placeholder} readOnly={!onChange} />
        <Button
          size="sm"
          disabled={!browse || !onChange || !desktop || browsing}
          title={desktop ? msg("m0188") : msg("m1138")}
          onClick={() => void selectPath()}
        >
          {browsing ? <Spinner /> : null}{msg("m0910")}
        </Button>
      </div>
    </Field>
  );
}

function FilmIcon() { return <FileVideo2 size={15} />; }
