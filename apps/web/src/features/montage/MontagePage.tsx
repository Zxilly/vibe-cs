import { msg, msgf } from '../../shared/i18n';
import {
  ArrowDown,
  ArrowLeft,
  ArrowUp,
  Check,
  Clapperboard,
  Clock3,
  Download,
  Film,
  FolderOpen,
  GripVertical,
  Image,
  LayoutTemplate,
  Music2,
  Upload,
  Play,
  Plus,
  RotateCcw,
  Search,
  Settings2,
  Sparkles,
  UserRound,
  WandSparkles,
  X,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';

import { commands, desktopMediaUrl, readableError } from '../../shared/desktop/client';
import type {
  ExportJobRecord,
  JobAccepted,
  MediaAsset,
  MontageProjectRecord,
  RecordedClip,
} from '../../shared/desktop/dto';
import { chooseLocalFile, isDesktopShell } from '../../shared/desktop/dialog';
import { useAsyncAction } from '../../shared/hooks/useAsyncAction';
import { useI18n } from '../../shared/i18n';
import {
  Badge,
  Button,
  EmptyState,
  Field,
  IconButton,
  Notice,
  PageHeader,
  Spinner,
  TextInput,
} from '../../shared/ui';
import {
  buildMontageDraft,
  montageDuration,
  type MontageTimelineItem,
  type MontageBrandingTheme,
  type MontageTransition,
  toMontageTimelineItem,
} from './montageProject';

const clipColor = (index: number) => ['amber', 'rose', 'blue', 'violet', 'emerald'][index % 5] ?? 'amber';
const transitionLabel: Record<MontageTransition, string> = {
  cut: msg("m1030"),
  fade: msg("m0918"),
  flash: msg("m1279"),
  dip: msg("m0915"),
  zoom: msg("m1087"),
  wipe: msg("m0678"),
  whip: msg("m0938"),
  blur: msg("m0839"),
  glitch: msg("m0679"),
  spin: msg("m0702"),
};

export function MontagePage() {
  const { t } = useI18n();
  const [clips, setClips] = useState<RecordedClip[]>([]);
  const [source, setSource] = useState<'loading' | 'service' | 'unavailable'>('loading');
  const [loadError, setLoadError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [timeline, setTimeline] = useState<MontageTimelineItem[]>([]);
  const [selectedId, setSelectedId] = useState(timeline[0]?.clip.id ?? null);
  const [name, setName] = useState(() => msg("m0753"));
  const [resolution, setResolution] = useState<'1080p' | '1440p' | '2160p'>('1440p');
  const [fps, setFps] = useState<30 | 60>(60);
  const [transitionSeconds, setTransitionSeconds] = useState(0.35);
  const [introEnabled, setIntroEnabled] = useState(true);
  const [introTitle, setIntroTitle] = useState('VIBE CS');
  const [introDuration, setIntroDuration] = useState(2.5);
  const [includeNameCards, setIncludeNameCards] = useState(true);
  const [backgroundMusic, setBackgroundMusic] = useState('');
  const [musicVolume, setMusicVolume] = useState(0.25);
  const [outroEnabled, setOutroEnabled] = useState(true);
  const [outroTitle, setOutroTitle] = useState('THANKS FOR WATCHING');
  const [outroDuration, setOutroDuration] = useState(2.5);
  const [brandingTheme, setBrandingTheme] = useState<MontageBrandingTheme>('vibe');
  const avatarInput = useRef<HTMLInputElement>(null);
  const [previewClipId, setPreviewClipId] = useState<string | null>(null);
  const [exportJobId, setExportJobId] = useState<string | null>(null);
  const [exportJob, setExportJob] = useState<ExportJobRecord | null>(null);
  const [exportPollError, setExportPollError] = useState<string | null>(null);
  const exportAction = useAsyncAction<JobAccepted>();
  const cancelExportAction = useAsyncAction<ExportJobRecord>();
  const saveAction = useAsyncAction<MontageProjectRecord>();
  const avatarAction = useAsyncAction<{ items: MediaAsset[] }>();

  useEffect(() => {
    const controller = new AbortController();
    void commands.listRecordedClips(controller.signal)
      .then((response) => {
        setClips(response.items);
        setTimeline(response.items.slice(0, 3).map(toMontageTimelineItem));
        setSelectedId(response.items[0]?.id ?? null);
        setSource('service');
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setClips([]);
        setTimeline([]);
        setSelectedId(null);
        setSource('unavailable');
        setLoadError(readableError(error));
      });
    return () => controller.abort();
  }, []);

  useEffect(() => {
    if (!exportJobId) return undefined;
    let disposed = false;
    let timer: number | undefined;
    const controller = new AbortController();
    const refresh = async () => {
      try {
        const next = await commands.getExportJob(exportJobId, controller.signal);
        if (disposed) return;
        setExportJob(next);
        setExportPollError(null);
        if (['completed', 'failed', 'cancelled'].includes(next.job.status)) {
          setExportJobId(null);
          return;
        }
        timer = window.setTimeout(() => void refresh(), 500);
      } catch (error) {
        if (disposed) return;
        setExportPollError(readableError(error));
        timer = window.setTimeout(() => void refresh(), 2_000);
      }
    };
    void refresh();
    return () => {
      disposed = true;
      controller.abort();
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [exportJobId]);

  const filteredClips = useMemo(() => {
    const query = search.trim().toLocaleLowerCase();
    return clips.filter((clip) => !query || `${clip.title} ${clip.player_name} ${clip.map_name}`.toLocaleLowerCase().includes(query));
  }, [clips, search]);

  const selectedItem = timeline.find((item) => item.clip.id === selectedId) ?? null;
  const selected = selectedItem?.clip ?? null;
  const displayedClip = (previewClipId ? clips.find((clip) => clip.id === previewClipId) : null) ?? selected;
  const totalDuration = useMemo(
    () => montageDuration(
      timeline,
      transitionSeconds,
      introEnabled ? introDuration : 0,
      outroEnabled ? outroDuration : 0,
    ),
    [introDuration, introEnabled, outroDuration, outroEnabled, timeline, transitionSeconds],
  );
  const invalidTimeline = timeline.some((item) => item.trimStart < 0 || item.trimEnd <= item.trimStart || item.trimEnd > item.clip.duration_seconds);

  const addClip = (clip: RecordedClip) => {
    if (timeline.some((item) => item.clip.id === clip.id)) return;
    setTimeline((items) => [...items, toMontageTimelineItem(clip)]);
    setSelectedId(clip.id);
  };

  const removeClip = (id: string) => {
    setTimeline((items) => items.filter((item) => item.clip.id !== id));
    if (selectedId === id) setSelectedId(null);
  };

  const updateItem = (id: string, patch: Partial<Omit<MontageTimelineItem, 'clip'>>) => {
    setTimeline((items) => items.map((item) => item.clip.id === id ? { ...item, ...patch } : item));
  };

  const moveClip = (index: number, direction: -1 | 1) => {
    const destination = index + direction;
    if (destination < 0 || destination >= timeline.length) return;
    setTimeline((current) => {
      const next = [...current];
      const [item] = next.splice(index, 1);
      if (!item) return current;
      next.splice(destination, 0, item);
      return next;
    });
  };

  const projectBody = () => buildMontageDraft({
    name,
    timeline,
    resolution,
    fps,
    transitionSeconds,
    introEnabled,
    introTitle,
    introDuration,
    includeNameCards,
    backgroundMusic,
    musicVolume,
    outroEnabled,
    outroTitle,
    outroDuration,
    brandingTheme,
  });

  const uploadSelectedAvatar = async (file: File | undefined) => {
    if (!file || !selectedItem) return;
    if (!file.type.startsWith('image/') || file.size > 20 * 1024 * 1024) return;
    const response = await avatarAction.run(
      () => commands.uploadMediaAssets([file]),
      msg("m0979"),
    );
    const asset = response?.items[0];
    if (asset) updateItem(selectedItem.clip.id, { avatarAssetId: asset.id });
  };

  const exportMontage = async () => {
    const result = await exportAction.run(async () => {
      const project = await commands.createMontageProject(projectBody());
      return commands.exportMontageProject(project.id);
    }, msg("m0458"));
    if (result) {
      setExportJob(null);
      setExportPollError(null);
      setExportJobId(result.job_id);
    }
  };

  const saveDraft = () => saveAction.run(
    () => commands.createMontageProject(projectBody()),
    msg("m1286"),
  );

  const cancelExport = async () => {
    if (!exportJobId) return;
    const result = await cancelExportAction.run(
      () => commands.cancelExportJob(exportJobId),
      msg("m0538"),
    );
    if (result) setExportJob(result);
  };

  const chooseMusic = async () => {
    const path = await chooseLocalFile({
      title: msg("m1239"),
      filters: [{ name: msg("m1300"), extensions: ['mp3', 'wav', 'm4a', 'aac', 'flac', 'ogg'] }],
    });
    if (path) setBackgroundMusic(path);
  };

  const canSubmit = source === 'service'
    && timeline.length > 0
    && !invalidTimeline
    && name.trim().length > 0
    && (!introEnabled || introTitle.trim().length > 0)
    && (!outroEnabled || outroTitle.trim().length > 0);

  return (
    <div className="page page--montage">
      <PageHeader
        eyebrow="MONTAGE WORKBENCH"
        title={t('montage.title')}
        description={t('montage.description')}
        actions={
          <>
            <Link className="button button--secondary button--md" to="/studio"><ArrowLeft size={14} />{t('studio.back')}</Link>
            <Button disabled={!canSubmit || saveAction.state.status === 'loading'} onClick={() => void saveDraft()}>{saveAction.state.status === 'loading' ? <Spinner /> : <LayoutTemplate size={15} />}{t('montage.saveDraft')}</Button>
            <Button variant="primary" disabled={!canSubmit || exportAction.state.status === 'loading' || exportJobId !== null} onClick={() => void exportMontage()}>
              {exportAction.state.status === 'loading' ? <Spinner /> : <Download size={15} />}{exportJobId ? t('common.loading') : t('montage.startExport')}
            </Button>
          </>
        }
      />

      {source !== 'service' ? <Notice tone={source === 'loading' ? 'info' : 'warning'} title={msg("m1071")}>{source === 'loading' ? msg("m0866") : loadError ?? msg("m1209")}</Notice> : null}
      {invalidTimeline ? <Notice tone="danger">{msg("m1099")}</Notice> : null}
      {exportAction.state.message ? <Notice tone={exportAction.state.status === 'error' ? 'danger' : 'success'}>{exportAction.state.message}</Notice> : null}
      {exportPollError ? <Notice tone="warning">{exportPollError}{msg("m1335")}</Notice> : null}
      {cancelExportAction.state.message ? <Notice tone={cancelExportAction.state.status === 'error' ? 'danger' : 'success'}>{cancelExportAction.state.message}</Notice> : null}
      {saveAction.state.message ? <Notice tone={saveAction.state.status === 'error' ? 'danger' : 'success'}>{saveAction.state.message}</Notice> : null}
      {avatarAction.state.message ? <Notice tone={avatarAction.state.status === 'error' ? 'danger' : 'success'}>{avatarAction.state.message}</Notice> : null}
      <input ref={avatarInput} className="visually-hidden" type="file" accept="image/png,image/jpeg,image/webp" onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ''; void uploadSelectedAvatar(file); }} />

      <div className="montage-workbench">
        <aside className="montage-materials panel-surface">
          <header className="panel-title"><div><span className="eyebrow">MATERIALS</span><h2>{t('montage.materials')}</h2></div><Badge tone="neutral">{clips.length}</Badge></header>
          <div className="material-search"><Search size={14} /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder={msg("m1068")} aria-label={msg("m1069")} /></div>
          <div className="material-list">
            {filteredClips.map((clip, index) => {
              const used = timeline.some((item) => item.clip.id === clip.id);
              return <article key={clip.id} className={used ? 'is-used' : undefined}><div className={`material-thumb material-thumb--${clipColor(index)}`}><span>{clip.duration_seconds.toFixed(1)}s</span><button type="button" aria-label={msgf("m1310", [clip.title])} onClick={() => { setSelectedId(clip.id); setPreviewClipId(clip.id); }}><Play size={14} /></button></div><div className="material-copy"><strong>{clip.title}</strong><span>{clip.player_name} · {clip.map_name.replace('de_', '')}</span></div><IconButton label={used ? msg("m0503") : msg("m0302")} disabled={used} onClick={() => addClip(clip)}>{used ? <Check size={14} /> : <Plus size={14} />}</IconButton></article>;
            })}
          </div>
        </aside>

        <section className="montage-stage panel-surface">
          <header className="panel-title"><div><span className="eyebrow">SEQUENCE</span><h2>{t('montage.sequence')}</h2></div><div className="panel-title__meta"><Clock3 size={13} />{totalDuration.toFixed(1)}s</div></header>
          <div className="montage-player">
            {displayedClip && previewClipId === displayedClip.id ? <video key={displayedClip.id} className="montage-player__media" src={desktopMediaUrl(displayedClip.stream_url)} controls autoPlay playsInline preload="metadata" onError={() => setPreviewClipId(null)} /> : <><div className="montage-player__title">{selectedItem?.avatarAssetId ? <img src={desktopMediaUrl(`/api/media/assets/${encodeURIComponent(selectedItem.avatarAssetId)}/stream`)} alt={msg("m0430")} width="64" height="64" /> : null}<span>{introEnabled ? introTitle : msg("m1072")}</span><strong>{displayedClip?.title ?? msg("m1238")}</strong><small>{displayedClip ? `${displayedClip.player_name} · ${displayedClip.map_name}` : msgf("m0115", [transitionSeconds.toFixed(2)])}</small></div><button type="button" className="montage-player__play" aria-label={displayedClip ? msgf("m1310", [displayedClip.title]) : msg("m1148")} disabled={!displayedClip} onClick={() => displayedClip && setPreviewClipId(displayedClip.id)}><Play size={22} fill="currentColor" /></button></>}
            <div className="montage-player__hud"><span>00:00 / {totalDuration.toFixed(0)}s</span><span>{resolution.toUpperCase()} · {fps} FPS</span></div>
          </div>
          <div className="sequence-toolbar"><div><Badge tone="accent">{timeline.length} CLIPS</Badge><span>{msg("m1236")}</span></div><Button size="sm" onClick={() => setTimeline((current) => [...current].reverse())}><RotateCcw size={13} />{msg("m0322")}</Button></div>
          {timeline.length > 0 ? (
            <div className="montage-sequence">
              {timeline.map((item, index) => <div className="sequence-group" key={item.clip.id}>{index > 0 ? <span className="transition-chip"><WandSparkles size={12} />{transitionLabel[item.transition]}</span> : null}<article className={selectedId === item.clip.id ? 'is-selected' : undefined}><button type="button" className="sequence-clip" onClick={() => setSelectedId(item.clip.id)}><GripVertical size={15} /><span className={`sequence-thumb material-thumb--${clipColor(index)}`}>{String(index + 1).padStart(2, '0')}</span><span className="sequence-copy"><strong>{item.clip.title}</strong><small>{item.trimStart.toFixed(1)}–{item.trimEnd.toFixed(1)}s · {(item.trimEnd - item.trimStart).toFixed(1)}s</small></span></button><div className="sequence-actions"><IconButton label={msg("m0138")} disabled={index === 0} onClick={() => moveClip(index, -1)}><ArrowUp size={13} /></IconButton><IconButton label={msg("m0141")} disabled={index === timeline.length - 1} onClick={() => moveClip(index, 1)}><ArrowDown size={13} /></IconButton><IconButton label={msg("m1048")} onClick={() => removeClip(item.clip.id)}><X size={13} /></IconButton></div></article></div>)}
            </div>
          ) : <EmptyState icon={<Clapperboard size={24} />} title={t('montage.empty')} description={t('montage.emptyDescription')} />}
        </section>

        <aside className="montage-settings panel-surface">
          <header className="panel-title"><div><span className="eyebrow">OUTPUT</span><h2>{t('montage.styleExport')}</h2></div><Settings2 size={16} /></header>
          <div className="settings-stack">
            <Field label={msg("m1308")}><TextInput value={name} maxLength={200} onChange={(event) => setName(event.target.value)} /></Field>
            {selectedItem ? <div className="setting-section"><h3><Clock3 size={14} />{msg("m0966")}</h3><div className="field-row"><Field label={msg("m0223")}><TextInput type="number" min="0" max={selectedItem.trimEnd - 0.05} step="0.05" value={selectedItem.trimStart} onChange={(event) => updateItem(selectedItem.clip.id, { trimStart: Number(event.target.value) })} /></Field><Field label={msg("m0251")}><TextInput type="number" min={selectedItem.trimStart + 0.05} max={selectedItem.clip.duration_seconds} step="0.05" value={selectedItem.trimEnd} onChange={(event) => updateItem(selectedItem.clip.id, { trimEnd: Number(event.target.value) })} /></Field></div><Field label={msg("m1205")}><select value={selectedItem.transition} disabled={timeline[0]?.clip.id === selectedItem.clip.id} onChange={(event) => updateItem(selectedItem.clip.id, { transition: event.target.value as MontageTransition })}>{Object.entries(transitionLabel).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></Field><Button size="sm" disabled={avatarAction.state.status === 'loading'} onClick={() => avatarInput.current?.click()}>{avatarAction.state.status === 'loading' ? <Spinner /> : <Upload size={12} />}{selectedItem.avatarAssetId ? msg("m0733") : msg("m0136")}</Button></div> : null}
            <div className="setting-section"><h3><WandSparkles size={14} />{msg("m1174")}</h3><Field label={msgf("m0716", [transitionSeconds.toFixed(2)])}><input type="range" min="0.1" max="1.5" step="0.05" value={transitionSeconds} onChange={(event) => setTransitionSeconds(Number(event.target.value))} /></Field></div>
            <div className="setting-section"><h3><Sparkles size={14} />{t('montage.branding')}</h3><Field label={t('montage.theme')}><select value={brandingTheme} onChange={(event) => setBrandingTheme(event.target.value as MontageBrandingTheme)}><option value="vibe">Vibe CS</option><option value="broadcast">Broadcast</option><option value="minimal">Minimal</option><option value="neon">Neon</option></select></Field><div className="toggle-list"><label><span><Image size={14} /><span><strong>{t('montage.intro')}</strong><small>{introEnabled ? `${introDuration.toFixed(1)}s` : 'OFF'}</small></span></span><input type="checkbox" checked={introEnabled} onChange={(event) => setIntroEnabled(event.target.checked)} /></label><label><span><UserRound size={14} /><span><strong>{t('montage.nameCards')}</strong><small>Avatar</small></span></span><input type="checkbox" checked={includeNameCards} onChange={(event) => setIncludeNameCards(event.target.checked)} /></label><label><span><Film size={14} /><span><strong>{t('montage.outro')}</strong><small>{outroEnabled ? `${outroDuration.toFixed(1)}s` : 'OFF'}</small></span></span><input type="checkbox" checked={outroEnabled} onChange={(event) => setOutroEnabled(event.target.checked)} /></label></div>{introEnabled ? <><Field label={t('montage.intro')}><TextInput value={introTitle} maxLength={200} onChange={(event) => setIntroTitle(event.target.value)} /></Field><Field label={`${t('montage.intro')} · ${introDuration.toFixed(1)}s`}><input type="range" min="0.5" max="8" step="0.1" value={introDuration} onChange={(event) => setIntroDuration(Number(event.target.value))} /></Field></> : null}{outroEnabled ? <><Field label={t('montage.outro')}><TextInput value={outroTitle} maxLength={200} onChange={(event) => setOutroTitle(event.target.value)} /></Field><Field label={`${t('montage.outro')} · ${outroDuration.toFixed(1)}s`}><input type="range" min="0.5" max="8" step="0.1" value={outroDuration} onChange={(event) => setOutroDuration(Number(event.target.value))} /></Field></> : null}</div>
            <div className="setting-section"><h3><Music2 size={14} />{t('montage.music')}</h3><Field label={t('montage.audioPath')}><div className="path-picker-row"><TextInput value={backgroundMusic} placeholder="Optional" onChange={(event) => setBackgroundMusic(event.target.value)} /><IconButton label={t('montage.music')} disabled={!isDesktopShell()} onClick={() => void chooseMusic()}><FolderOpen size={14} /></IconButton></div></Field><Field label={`${t('montage.music')} · ${Math.round(musicVolume * 100)}%`}><input type="range" min="0" max="100" value={Math.round(musicVolume * 100)} onChange={(event) => setMusicVolume(Number(event.target.value) / 100)} /></Field></div>
            <div className="setting-section"><h3><Film size={14} />{t('montage.output')}</h3><Field label={t('montage.resolution')}><select value={resolution} onChange={(event) => setResolution(event.target.value as typeof resolution)}><option value="1080p">1920 × 1080</option><option value="1440p">2560 × 1440</option><option value="2160p">3840 × 2160</option></select></Field><Field label={t('montage.frameRate')}><div className="mini-segmented">{([30, 60] as const).map((value) => <button type="button" key={value} className={fps === value ? 'is-active' : undefined} onClick={() => setFps(value)}>{value} FPS</button>)}</div></Field></div>
          </div>
          {exportJob ? <div className="export-job-card" aria-live="polite"><div><span>{exportJob.job.status}</span><strong>{Math.round(exportJob.job.progress * 100)}%</strong></div><div className="export-job-card__bar"><span style={{ width: `${Math.max(0, Math.min(100, exportJob.job.progress * 100))}%` }} /></div>{exportJob.job.error ? <small>{exportJob.job.error}</small> : exportJob.job.output_path ? <small title={exportJob.job.output_path}>{exportJob.job.output_path}</small> : <small>{msg("m0784")}</small>}{exportJobId ? <Button size="sm" variant="danger" disabled={cancelExportAction.state.status === 'loading'} onClick={() => void cancelExport()}>{cancelExportAction.state.status === 'loading' ? <Spinner /> : <X size={12} />}{msg("m0325")}</Button> : null}</div> : null}
        </aside>
      </div>
    </div>
  );
}
