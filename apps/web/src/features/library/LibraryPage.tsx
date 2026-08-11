import { currentLocale, msg, msgf } from '../../shared/i18n';
import {
  ArrowDownUp,
  CalendarDays,
  CheckSquare,
  Clock3,
  FileVideo2,
  Filter,
  FolderPlus,
  Grid2X2,
  Import,
  List,
  Map,
  MoreHorizontal,
  PencilLine,
  Play,
  RefreshCw,
  Radio,
  ScanSearch,
  Search,
  Sparkles,
  Trash2,
  Upload,
  Users,
} from 'lucide-react';
import { type ChangeEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';

import { commands, desktopMediaUrl, readableError } from '../../shared/desktop/client';
import type { AnalysisWorkspace, DemoStatus, DemoSummary, DemoWatchStatus, RadarOverviewRecord } from '../../shared/desktop/dto';
import { chooseLocalDirectories, chooseLocalFiles, isDesktopShell } from '../../shared/desktop/dialog';
import { useAsyncAction } from '../../shared/hooks/useAsyncAction';
import { useI18n } from '../../shared/i18n';
import { runManagedPlaybackLaunch, useRuntimeStore } from '../../shared/stores/runtimeStore';
import {
  Badge,
  Button,
  Card,
  Drawer,
  Field,
  IconButton,
  Notice,
  PageHeader,
  SegmentedControl,
  Spinner,
  TextInput,
} from '../../shared/ui';
import { LibrarySectionNav } from './LibrarySectionNav';

type ViewMode = 'grid' | 'list';
type SortMode = 'newest' | 'oldest' | 'name';

const statusLabel: Record<DemoStatus, string> = {
  pending: msg("m0612"),
  parsing: msg("m0263"),
  ready: msg("m0346"),
  error: msg("m1288"),
};

const statusTone: Record<DemoStatus, 'neutral' | 'warning' | 'success' | 'danger'> = {
  pending: 'neutral',
  parsing: 'warning',
  ready: 'success',
  error: 'danger',
};

function duration(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(Math.round(seconds % 60)).padStart(2, '0')}`;
}

export function LibraryPage() {
  const { t } = useI18n();
  const navigate = useNavigate();
  const runtimeSession = useRuntimeStore((state) => state.session);
  const fileInput = useRef<HTMLInputElement>(null);
  const [demos, setDemos] = useState<DemoSummary[]>([]);
  const [source, setSource] = useState<'loading' | 'service' | 'unavailable'>('loading');
  const [loadError, setLoadError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [mapFilter, setMapFilter] = useState('all');
  const [statusFilter, setStatusFilter] = useState<'all' | DemoStatus>('all');
  const [sort, setSort] = useState<SortMode>('newest');
  const [view, setView] = useState<ViewMode>('grid');
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [activeDemo, setActiveDemo] = useState<DemoSummary | null>(null);
  const [detailAnalysis, setDetailAnalysis] = useState<AnalysisWorkspace | null>(null);
  const [detailAnalysisError, setDetailAnalysisError] = useState<string | null>(null);
  const [editName, setEditName] = useState('');
  const [editRemark, setEditRemark] = useState('');
  const scanAction = useAsyncAction<{ discovered: number; imported: number }>();
  const importAction = useAsyncAction<{ discovered: number; imported: number }>();
  const saveAction = useAsyncAction<DemoSummary>();
  const deleteAction = useAsyncAction<boolean>();
  const playAction = useAsyncAction<{ started: boolean; process_id: number }>();
  const [playingDemoId, setPlayingDemoId] = useState<string | null>(null);
  const [watchStatus, setWatchStatus] = useState<DemoWatchStatus | null>(null);
  const [watchError, setWatchError] = useState<string | null>(null);
  const watchAction = useAsyncAction<DemoWatchStatus>();
  const desktopShell = useMemo(isDesktopShell, []);

  const refreshDemos = useCallback(async (signal?: AbortSignal) => {
    const response = await commands.listDemos({ page: 1, page_size: 100, sort: 'newest' }, signal);
    setDemos(response.items);
    setSource('service');
    setLoadError(null);
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void refreshDemos(controller.signal)
      .catch((error: unknown) => {
        setDemos([]);
        setSource('unavailable');
        setLoadError(readableError(error));
      });
    void commands.getDemoWatchStatus(controller.signal)
      .then((status) => {
        setWatchStatus(status);
        setWatchError(null);
      })
      .catch((error: unknown) => setWatchError(readableError(error)));
    return () => controller.abort();
  }, [refreshDemos]);

  useEffect(() => {
    if (source !== 'service') return undefined;
    let disposed = false;
    const controller = new AbortController();
    let previousScan = watchStatus?.last_scan_at ?? null;
    const poll = window.setInterval(() => {
      void commands.getDemoWatchStatus(controller.signal)
        .then(async (status) => {
          if (disposed) return;
          setWatchStatus(status);
          setWatchError(null);
          if (status.last_scan_at && status.last_scan_at !== previousScan) {
            previousScan = status.last_scan_at;
            await refreshDemos(controller.signal);
          }
        })
        .catch((error: unknown) => {
          if (!disposed) setWatchError(readableError(error));
        });
    }, 4_000);
    return () => {
      disposed = true;
      controller.abort();
      window.clearInterval(poll);
    };
  }, [refreshDemos, source, watchStatus?.last_scan_at]);

  const maps = useMemo(
    () => [...new Set(demos.map((demo) => demo.map_name))].sort(),
    [demos],
  );

  const filteredDemos = useMemo(() => {
    const normalized = search.trim().toLocaleLowerCase();
    const result = demos.filter((demo) => {
      const matchesSearch =
        !normalized ||
        `${demo.display_name} ${demo.filename} ${demo.map_name} ${demo.players.join(' ')}`
          .toLocaleLowerCase()
          .includes(normalized);
      return (
        matchesSearch &&
        (mapFilter === 'all' || demo.map_name === mapFilter) &&
        (statusFilter === 'all' || demo.status === statusFilter)
      );
    });
    return result.sort((a, b) => {
      if (sort === 'name') return a.display_name.localeCompare(b.display_name, 'zh-CN');
      const delta = Date.parse(a.played_at) - Date.parse(b.played_at);
      return sort === 'oldest' ? delta : -delta;
    });
  }, [demos, mapFilter, search, sort, statusFilter]);

  const openDetails = (demo: DemoSummary) => {
    setActiveDemo(demo);
    setEditName(demo.display_name);
    setEditRemark(demo.remark ?? '');
    saveAction.reset();
  };

  useEffect(() => {
    if (!activeDemo || source !== 'service' || activeDemo.status !== 'ready') {
      setDetailAnalysis(null);
      setDetailAnalysisError(null);
      return undefined;
    }
    const controller = new AbortController();
    setDetailAnalysis(null);
    setDetailAnalysisError(null);
    void commands.getAnalysis(activeDemo.id, controller.signal)
      .then(setDetailAnalysis)
      .catch((error: unknown) => {
        if (!controller.signal.aborted) setDetailAnalysisError(readableError(error));
      });
    return () => controller.abort();
  }, [activeDemo, source]);

  const toggleSelected = (id: string) => {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handleScan = async () => {
    const result = await scanAction.run(() => commands.scanDemos(), msg("m0643"));
    if (result && source === 'service') {
      const response = await commands.listDemos({ page: 1, page_size: 100, sort: 'newest' });
      setDemos(response.items);
    }
  };

  const handleImportButton = async () => {
    if (!desktopShell) {
      fileInput.current?.click();
      return;
    }
    const paths = await chooseLocalFiles({
      title: msg("m1218"),
      filters: [{ name: msg("m0886"), extensions: ['dem', 'zip'] }],
    });
    if (paths.length === 0) return;
    const result = await importAction.run(
      () => commands.importDemoPaths(paths),
      msg("m0456"),
    );
    if (result && source === 'service') await refreshDemos();
  };

  const handleAddWatchDirectories = async () => {
    const paths = await chooseLocalDirectories({ title: msg("m1241") });
    if (paths.length === 0) return;
    const status = await watchAction.run(async () => {
      const config = await commands.getConfig();
      const known = new Set(config.demo_watch_paths.map((path) => path.toLocaleLowerCase()));
      const additions = paths.filter((path) => !known.has(path.toLocaleLowerCase()));
      await commands.updateConfig({
        ...config,
        demo_watch_paths: [...config.demo_watch_paths, ...additions],
      });
      return commands.getDemoWatchStatus();
    }, msg("m1008"));
    if (status) {
      setWatchStatus(status);
      await refreshDemos();
    }
  };

  const handleWatchRescan = async () => {
    const status = await watchAction.run(
      () => commands.rescanDemoWatch(),
      msg("m1009"),
    );
    if (status) {
      setWatchStatus(status);
      await refreshDemos();
    }
  };

  const handleImport = async (event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files ?? []);
    event.target.value = '';
    if (files.length === 0) return;
    const result = await importAction.run(() => commands.importDemos(files), msg("m0137"));
    if (result && source === 'service') {
      const response = await commands.listDemos({ page: 1, page_size: 100, sort: 'newest' });
      setDemos(response.items);
    }
  };

  const handleSave = async () => {
    if (!activeDemo) return;
    const updated = await saveAction.run(
      () => commands.updateDemo(activeDemo.id, { display_name: editName.trim(), remark: editRemark.trim() }),
      msg("m1163"),
    );
    if (!updated) return;
    setDemos((current) => current.map((demo) => demo.id === updated.id ? updated : demo));
    setActiveDemo(updated);
  };

  const handleDelete = async () => {
    if (!activeDemo) return;
    if (!window.confirm(msgf("m0191", [activeDemo.display_name]))) return;
    const deleted = await deleteAction.run(
      async () => {
        await commands.deleteDemo(activeDemo.id);
        return true;
      },
      msg("m1165"),
    );
    if (!deleted) return;
    setDemos((current) => current.filter((demo) => demo.id !== activeDemo.id));
    setActiveDemo(null);
  };

  const handlePlay = async (demo: DemoSummary) => {
    if (demo.status !== 'ready') return;
    setPlayingDemoId(demo.id);
    await playAction.run(
      () => runManagedPlaybackLaunch(() => commands.playDemo(demo.id)),
      msg("m0513"),
    );
    setPlayingDemoId(null);
  };

  const isBusy = scanAction.state.status === 'loading' || importAction.state.status === 'loading';

  return (
    <div className="page page--library">
      <PageHeader
        eyebrow="DEMO LIBRARY"
        title={t('library.title')}
        description={`${demos.length} · ${t('library.description')}`}
        actions={
          <>
            <input
              ref={fileInput}
              className="sr-only"
              type="file"
              accept=".dem,.zip"
              multiple
              onChange={(event) => void handleImport(event)}
            />
            <Button onClick={() => void handleImportButton()} disabled={isBusy}>
              <Upload size={15} />{t('library.import')}
            </Button>
            <Button
              onClick={() => void handleAddWatchDirectories()}
              disabled={!desktopShell || watchAction.state.status === 'loading'}
              title={desktopShell ? msg("m0922") : msg("m1012")}
            >
              <FolderPlus size={15} />{t('library.watch')}
            </Button>
            <Button variant="primary" onClick={() => void handleScan()} disabled={isBusy}>
              {scanAction.state.status === 'loading' ? <Spinner /> : <ScanSearch size={15} />}
              {t('library.scan')}
            </Button>
          </>
        }
      />
      <LibrarySectionNav />

      {source !== 'service' ? (
        <Notice tone={source === 'loading' ? 'info' : 'warning'} title={source === 'loading' ? msg("m0876") : t('common.unavailable')}>
          {source === 'loading' ? msg("m0868") : loadError ?? msg("m1210")}
        </Notice>
      ) : null}
      {scanAction.state.message ? (
        <Notice tone={scanAction.state.status === 'error' ? 'danger' : 'success'}>{scanAction.state.message}</Notice>
      ) : null}
      {importAction.state.message ? (
        <Notice tone={importAction.state.status === 'error' ? 'danger' : 'success'}>{importAction.state.message}</Notice>
      ) : null}
      {playAction.state.message ? (
        <Notice tone={playAction.state.status === 'error' ? 'danger' : 'success'}>{playAction.state.message}</Notice>
      ) : null}
      {watchAction.state.message ? (
        <Notice tone={watchAction.state.status === 'error' ? 'danger' : 'success'}>{watchAction.state.message}</Notice>
      ) : null}
      {watchError ? <Notice tone="danger" title={msg("m0709")}>{watchError}</Notice> : null}

      {watchStatus ? (
        <Card className="watch-status-card">
          <div className="watch-status-card__summary">
            <span className={watchStatus.running ? 'watch-indicator is-active' : 'watch-indicator'}>
              <Radio size={15} />
            </span>
            <div>
              <strong>{watchStatus.running ? msg("m1010") : msg("m0468")}</strong>
              <span>
                {watchStatus.roots.length} {msg("m0159")}
                {watchStatus.last_scan_at
                  ? msgf("m0008", [new Intl.DateTimeFormat(currentLocale(), { hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(new Date(watchStatus.last_scan_at))])
                  : msg("m0010")}
               {msgf("m0005", [watchStatus.imported, watchStatus.updated, watchStatus.missing])}
              </span>
            </div>
          </div>
          <div className="watch-root-list">
            {watchStatus.roots.map((root, index) => (
              <span key={`${index}:${root.path}`} className={`watch-root watch-root--${root.state}`} title={root.message ?? root.path}>
                {root.state === 'watching' ? msg("m1006") : root.state === 'missing' ? msg("m1011") : msg("m1288")} · {root.path}
              </span>
            ))}
            {watchStatus.last_error ? <span className="watch-root watch-root--error">{watchStatus.last_error}</span> : null}
          </div>
          <Button
            size="sm"
            onClick={() => void handleWatchRescan()}
            disabled={watchAction.state.status === 'loading' || watchStatus.roots.length === 0}
          >
            {watchAction.state.status === 'loading' ? <Spinner /> : <RefreshCw size={14} />}{msg("m1056")}
          </Button>
        </Card>
      ) : null}

      <Card className="library-toolbar">
        <div className="search-box">
          <Search size={16} />
          <input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder={msg("m0668")}
            aria-label={msg("m0671")}
          />
          <kbd>/</kbd>
        </div>
        <div className="toolbar-divider" />
        <label className="compact-select">
          <Map size={14} />
          <select value={mapFilter} onChange={(event) => setMapFilter(event.target.value)} aria-label={msg("m0399")}>
            <option value="all">{msg("m0231")}</option>
            {maps.map((mapName) => <option key={mapName} value={mapName}>{mapName.replace('de_', '')}</option>)}
          </select>
        </label>
        <label className="compact-select">
          <Filter size={14} />
          <select
            value={statusFilter}
            onChange={(event) => setStatusFilter(event.target.value as 'all' | DemoStatus)}
            aria-label={msg("m0976")}
          >
            <option value="all">{msg("m0234")}</option>
            <option value="ready">{msg("m0346")}</option>
            <option value="parsing">{msg("m0263")}</option>
            <option value="pending">{msg("m0612")}</option>
            <option value="error">{msg("m1288")}</option>
          </select>
        </label>
        <label className="compact-select">
          <ArrowDownUp size={14} />
          <select value={sort} onChange={(event) => setSort(event.target.value as SortMode)} aria-label={msg("m0661")}>
            <option value="newest">{msg("m0738")}</option>
            <option value="oldest">{msg("m0737")}</option>
            <option value="name">{msg("m0359")}</option>
          </select>
        </label>
        <div className="library-toolbar__spacer" />
        <SegmentedControl
          label={msg("m1106")}
          value={view}
          onChange={setView}
          options={[
            { value: 'grid', label: msg("m1090"), icon: <Grid2X2 size={14} /> },
            { value: 'list', label: msg("m0281"), icon: <List size={14} /> },
          ]}
        />
      </Card>

      {selectedIds.size > 0 ? (
        <div className="selection-bar">
          <CheckSquare size={16} />
          <strong>{msg("m0544")} {selectedIds.size} {msg("m0403")}</strong>
          <Button size="sm" onClick={() => setSelectedIds(new Set())}>{msg("m0328")}</Button>
          <Button size="sm" variant="primary" onClick={() => {
            const ids = [...selectedIds];
            const primary = ids[0];
            if (primary) void navigate(`/analysis?demo=${encodeURIComponent(primary)}&demos=${encodeURIComponent(ids.join(','))}`);
          }}>
            <Sparkles size={14} />{msg("m0644")}
          </Button>
        </div>
      ) : null}

      <div className={`demo-collection demo-collection--${view}`}>
        {filteredDemos.map((demo) => (
          <article
            className={`demo-card demo-card--${view}${selectedIds.has(demo.id) ? ' is-selected' : ''}`}
            key={demo.id}
          >
            <div className={`map-art map-art--${demo.map_name.replace('de_', '')}`}>
              <LibraryMapThumbnail mapName={demo.map_name} enabled={source === 'service'} />
              <span className="map-art__name">{demo.map_name.replace('de_', '').toUpperCase()}</span>
              <Badge tone={statusTone[demo.status]}>{statusLabel[demo.status]}</Badge>
              <button
                type="button"
                className="demo-card__select"
                aria-label={msgf("m0089", [selectedIds.has(demo.id) ? msg("m0328") : msg("m1216"), demo.display_name])}
                aria-pressed={selectedIds.has(demo.id)}
                onClick={() => toggleSelected(demo.id)}
              >
                <span />
              </button>
            </div>
            <div className="demo-card__body">
              <div className="demo-card__title">
                <div>
                  <h2>{demo.display_name}</h2>
                  <span>{demo.filename}</span>
                </div>
                <IconButton label={msg("m1086")} onClick={() => openDetails(demo)}><MoreHorizontal size={16} /></IconButton>
              </div>
              <div className="scoreline">
                <div><span>TEAM A</span><strong>{demo.score_team_a}</strong></div>
                <span>:</span>
                <div><strong>{demo.score_team_b}</strong><span>TEAM B</span></div>
              </div>
              <div className="demo-card__meta">
                <span><CalendarDays size={13} />{new Intl.DateTimeFormat(currentLocale(), { month: 'short', day: 'numeric' }).format(new Date(demo.played_at))}</span>
                <span><Clock3 size={13} />{duration(demo.duration_seconds)}</span>
                <span><Users size={13} />{demo.total_rounds} {msg("m0367")}</span>
              </div>
              <div className="demo-card__footer">
                <span className="source-pill"><Import size={12} />{demo.source === 'watch' ? msg("m1007") : demo.source === 'upload' ? msg("m0634") : msg("m0786")}</span>
                <div>
                  <IconButton
                    label={msg("m0391")}
                    disabled={demo.status !== 'ready' || playingDemoId !== null || runtimeSession !== 'idle'}
                    onClick={() => void handlePlay(demo)}
                  >
                    {playingDemoId === demo.id ? <Spinner /> : <Play size={15} />}
                  </IconButton>
                  <Button
                    size="sm"
                    variant="primary"
                    disabled={demo.status !== 'ready'}
                    onClick={() => void navigate(`/analysis?demo=${encodeURIComponent(demo.id)}`)}
                  >

                   {msg("m0257")}<ArrowRightIcon />
                  </Button>
                </div>
              </div>
            </div>
          </article>
        ))}
      </div>

      {filteredDemos.length === 0 ? (
        <div className="library-empty">
          <FileVideo2 size={26} />
          <h2>{msg("m0895")}</h2>
          <p>{msg("m1154")}</p>
          <Button onClick={() => { setSearch(''); setMapFilter('all'); setStatusFilter('all'); }}><RefreshCw size={14} />{msg("m0932")}</Button>
        </div>
      ) : null}

      <Drawer
        open={activeDemo !== null}
        title={msg("m0891")}
        description={activeDemo?.filename}
        onClose={() => setActiveDemo(null)}
        footer={
          <>
            <Button
              variant="danger"
              disabled={!activeDemo || deleteAction.state.status === 'loading'}
              onClick={() => void handleDelete()}
            >
              {deleteAction.state.status === 'loading' ? <Spinner /> : <Trash2 size={14} />}

             {msg("m1050")}
            </Button>
            <Button onClick={() => setActiveDemo(null)}>{msg("m0325")}</Button>
            <Button
              variant="primary"
              disabled={!activeDemo || saveAction.state.status === 'loading' || !editName.trim()}
              onClick={() => void handleSave()}
            >
              {saveAction.state.status === 'loading' ? <Spinner /> : <PencilLine size={14} />}

             {msg("m0215")}
            </Button>
          </>
        }
      >
        {activeDemo ? (
          <div className="drawer-form">
            {saveAction.state.message ? (
              <Notice tone={saveAction.state.status === 'error' ? 'danger' : 'success'}>{saveAction.state.message}</Notice>
            ) : null}
            <div className={`drawer-map-preview map-art--${activeDemo.map_name.replace('de_', '')}`}>
              <Map size={24} /><strong>{activeDemo.map_name.replace('de_', '').toUpperCase()}</strong>
            </div>
            <Field label={msg("m0726")}>
              <TextInput value={editName} onChange={(event) => setEditName(event.target.value)} maxLength={100} />
            </Field>
            <Field label={msg("m0415")} hint={msg("m1114")}>
              <textarea value={editRemark} onChange={(event) => setEditRemark(event.target.value)} rows={5} maxLength={1000} />
            </Field>
            <dl className="detail-list">
              <div><dt>{msg("m0396")}</dt><dd>{activeDemo.map_name}</dd></div>
              <div><dt>{msg("m0884")}</dt><dd>{activeDemo.score_team_a} : {activeDemo.score_team_b}</dd></div>
              <div><dt>{msg("m0715")}</dt><dd>{duration(activeDemo.duration_seconds)}</dd></div>
              <div><dt>{msg("m0370")}</dt><dd>{activeDemo.total_rounds}</dd></div>
              <div><dt>{msg("m0813")}</dt><dd>{activeDemo.source}</dd></div>
            </dl>
            {detailAnalysis ? (
              <div>
                <h3>{msg("m0443")}</h3>
                <div className="detail-list" role="table" aria-label={msg("m0443")}>
                  {detailAnalysis.players.map((player) => (
                    <div role="row" key={player.id}><dt role="cell">{player.name} · TEAM {player.team}</dt><dd role="cell">{player.kills} / {player.deaths} / {player.assists} · ADR {player.adr.toFixed(1)} · Rating {player.rating.toFixed(2)}</dd></div>
                  ))}
                </div>
              </div>
            ) : detailAnalysisError ? <Notice tone="info" title={msg("m1112")}>{detailAnalysisError}{msg("m0129")}</Notice> : activeDemo.status === 'ready' ? <Spinner /> : null}
          </div>
        ) : null}
      </Drawer>
    </div>
  );
}

const radarThumbnailCache = new globalThis.Map<string, Promise<RadarOverviewRecord | null>>();

function LibraryMapThumbnail({ mapName, enabled }: { mapName: string; enabled: boolean }) {
  const [radar, setRadar] = useState<RadarOverviewRecord | null>(null);
  useEffect(() => {
    if (!enabled || !mapName.trim()) return undefined;
    const promise = radarThumbnailCache.get(mapName) ?? commands.getRadarOverview(mapName).catch(() => null);
    radarThumbnailCache.set(mapName, promise);
    let active = true;
    void promise.then((value) => { if (active) setRadar(value); });
    return () => { active = false; };
  }, [enabled, mapName]);
  if (radar?.browser_displayable && radar.image_url) return <img className="radar-map-image" src={desktopMediaUrl(radar.image_url)} alt={msgf("m0112", [mapName])} />;
  return <div className="map-art__grid" />;
}

function ArrowRightIcon() {
  return <span aria-hidden="true">→</span>;
}
