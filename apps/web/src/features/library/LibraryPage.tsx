import { currentLocale, msg, msgf } from '../../shared/i18n';
import {
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
  Table2,
  Trash2,
  Upload,
  Users,
} from 'lucide-react';
import { type ChangeEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';

import { commands, desktopMediaUrl, readableError } from '../../shared/desktop/client';
import type { AnalysisWorkspace, DemoLifecycleStatus, DemoSummary, DemoWatchStatus, RadarOverviewRecord, ScanResult } from '../../shared/desktop/dto';
import { chooseLocalDirectories, chooseLocalFiles, isDesktopShell, revealLocalPath } from '../../shared/desktop/dialog';
import { useAsyncAction } from '../../shared/hooks/useAsyncAction';
import { useI18n } from '../../shared/i18n';
import { formatKillDeathRatioValue } from '../../shared/performanceMetrics';
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
import { requireSuccessfulImport } from './importResult';
import { demoLifecyclePresentation, hasVerifiedMatchScore } from './libraryPresentation';
import {
  libraryPageCount,
  libraryQueryFromParams,
  libraryQueryToDemoQuery,
  libraryQueryToParams,
  patchLibraryQuery,
  tableSortFromServerSort,
  toggleLibraryTableSort,
  setLibraryColumnVisibility,
  type LibraryOptionalColumn,
  type LibraryQueryState,
} from './libraryQuery';
import { isDemoAnalyzable, retainLibraryPageSelection } from './librarySelection';
import {
  LibraryDemoInspector,
  LibraryColumnVisibility,
  LibraryPagination,
  LibraryPowerTable,
  LibraryResultScope,
  type LibrarySortKey,
} from './libraryTable';

type ViewMode = 'table' | 'grid' | 'list';

function duration(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(Math.round(seconds % 60)).padStart(2, '0')}`;
}

function lifecycleNoticeTone(tone: ReturnType<typeof demoLifecyclePresentation>['tone']): 'info' | 'warning' | 'success' | 'danger' {
  return tone === 'neutral' ? 'info' : tone;
}

function useWideLibraryInspector(): boolean {
  const [wide, setWide] = useState(() => typeof window !== 'undefined' && window.matchMedia('(min-width: 1700px)').matches);
  useEffect(() => {
    const query = window.matchMedia('(min-width: 1700px)');
    const update = () => setWide(query.matches);
    update();
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);
  return wide;
}

export function LibraryWorkspaceSummary({
  demos,
  activeMap,
  onMapFilter,
}: {
  demos: DemoSummary[];
  activeMap: string;
  onMapFilter: (mapName: string) => void;
}) {
  const { t } = useI18n();
  const readyDemos = demos.filter((demo) => demo.lifecycle_status === 'ready');
  const mapIndex = [...demos.reduce((index, demo) => {
    index.set(demo.map_name, (index.get(demo.map_name) ?? 0) + 1);
    return index;
  }, new globalThis.Map<string, number>())]
    .sort(([leftName, leftCount], [rightName, rightCount]) => rightCount - leftCount || leftName.localeCompare(rightName));
  const verifiedRounds = readyDemos.reduce((total, demo) => total + demo.total_rounds, 0);

  return (
    <Card className="library-workspace-summary" role="complementary" aria-label={t('analysis.matchFacts')}>
      <header>
        <div>
          <span className="eyebrow">CURRENT PAGE INDEX</span>
          <h2>{t('analysis.matchFacts')}</h2>
        </div>
        <Badge tone="neutral">{demos.length}</Badge>
      </header>
      <dl className="library-workspace-summary__facts">
        <div><dt>{t('library.localMatches')}</dt><dd>{demos.length}</dd></div>
        <div><dt>{t('library.lifecycle.ready.label')}</dt><dd>{readyDemos.length}</dd></div>
        <div><dt>{t('analysis.roundCountLabel')}</dt><dd>{verifiedRounds}</dd></div>
        <div><dt>{t('evidenceSearch.map')}</dt><dd>{mapIndex.length}</dd></div>
      </dl>
      <div className="library-map-index" role="group" aria-label={t('evidenceSearch.map')}>
        {mapIndex.map(([mapName, count]) => (
          <button
            key={mapName}
            type="button"
            aria-pressed={activeMap === mapName}
            onClick={() => onMapFilter(mapName)}
          >
            <span><Map size={14} /><strong>{mapName.replace('de_', '').toUpperCase()}</strong></span>
            <Badge tone={activeMap === mapName ? 'blue' : 'neutral'}>{count}</Badge>
          </button>
        ))}
      </div>
    </Card>
  );
}

export function LibraryPage() {
  const { t } = useI18n();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const libraryQuery = useMemo(() => libraryQueryFromParams(searchParams), [searchParams]);
  const tableSort = useMemo(() => tableSortFromServerSort(libraryQuery.sort), [libraryQuery.sort]);
  const visibleTableColumns = useMemo(
    () => new Set(libraryQuery.columns),
    [libraryQuery.columns],
  );
  const runtimeSession = useRuntimeStore((state) => state.session);
  const fileInput = useRef<HTMLInputElement>(null);
  const [demos, setDemos] = useState<DemoSummary[]>([]);
  const [demoTotal, setDemoTotal] = useState(0);
  const [source, setSource] = useState<'loading' | 'service' | 'unavailable'>('loading');
  const [loadError, setLoadError] = useState<string | null>(null);
  const [view, setView] = useState<ViewMode>('table');
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [activeDemo, setActiveDemo] = useState<DemoSummary | null>(null);
  const [detailAnalysis, setDetailAnalysis] = useState<AnalysisWorkspace | null>(null);
  const [detailAnalysisError, setDetailAnalysisError] = useState<string | null>(null);
  const [editName, setEditName] = useState('');
  const [editRemark, setEditRemark] = useState('');
  const scanAction = useAsyncAction<{ discovered: number; imported: number }>();
  const importAction = useAsyncAction<ScanResult>();
  const saveAction = useAsyncAction<DemoSummary>();
  const deleteAction = useAsyncAction<boolean>();
  const playAction = useAsyncAction<{ started: boolean; process_id: number }>();
  const revealAction = useAsyncAction<boolean>();
  const [playingDemoId, setPlayingDemoId] = useState<string | null>(null);
  const [watchStatus, setWatchStatus] = useState<DemoWatchStatus | null>(null);
  const [watchError, setWatchError] = useState<string | null>(null);
  const watchAction = useAsyncAction<DemoWatchStatus>();
  const desktopShell = useMemo(isDesktopShell, []);
  const wideInspector = useWideLibraryInspector();

  const updateLibraryQuery = useCallback((
    patch: Partial<LibraryQueryState>,
    replace = false,
  ) => {
    const next = patchLibraryQuery(libraryQuery, patch);
    setSearchParams(libraryQueryToParams(next), { replace });
  }, [libraryQuery, setSearchParams]);

  const refreshDemos = useCallback(async (signal?: AbortSignal) => {
    const response = await commands.listDemos(libraryQueryToDemoQuery(libraryQuery), signal);
    const pages = libraryPageCount(response.total, response.page_size);
    if (response.total > 0 && response.page > pages) {
      setSearchParams(libraryQueryToParams({ ...libraryQuery, page: pages }), { replace: true });
      return;
    }
    setDemos(response.items);
    setDemoTotal(response.total);
    setSource('service');
    setLoadError(null);
  }, [libraryQuery, setSearchParams]);

  useEffect(() => {
    const controller = new AbortController();
    void refreshDemos(controller.signal)
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setDemos([]);
        setDemoTotal(0);
        setSource('unavailable');
        setLoadError(readableError(error));
      });
    return () => controller.abort();
  }, [refreshDemos]);

  useEffect(() => {
    const controller = new AbortController();
    void commands.getDemoWatchStatus(controller.signal)
      .then((status) => {
        setWatchStatus(status);
        setWatchError(null);
      })
      .catch((error: unknown) => setWatchError(readableError(error)));
    return () => controller.abort();
  }, []);

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

  useEffect(() => {
    setActiveDemo(null);
    setSelectedIds(new Set());
  }, [libraryQuery.map, libraryQuery.page, libraryQuery.pageSize, libraryQuery.search, libraryQuery.status]);

  useEffect(() => {
    const pageIds = demos.map((demo) => demo.id);
    const pageIdSet = new Set(pageIds);
    setActiveDemo((current) => current && pageIdSet.has(current.id) ? current : null);
    setSelectedIds((current) => {
      const next = retainLibraryPageSelection(current, pageIds);
      return next.size === current.size ? current : next;
    });
  }, [demos]);

  const selectedAnalysisIds = useMemo(() => {
    const analyzable = new Set(
      demos.filter((demo) => isDemoAnalyzable(demo.lifecycle_status)).map((demo) => demo.id),
    );
    return [...selectedIds].filter((id) => analyzable.has(id));
  }, [demos, selectedIds]);

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

  const toggleSelected = (demo: DemoSummary) => {
    if (!isDemoAnalyzable(demo.lifecycle_status)) return;
    setSelectedIds((current) => {
      const next = new Set(current);
      if (next.has(demo.id)) next.delete(demo.id);
      else next.add(demo.id);
      return next;
    });
  };

  const handleTableSort = (key: LibrarySortKey) => {
    updateLibraryQuery({ sort: toggleLibraryTableSort(libraryQuery.sort, key) });
  };

  const handleColumnVisibility = (column: LibraryOptionalColumn, visible: boolean) => {
    updateLibraryQuery({
      columns: setLibraryColumnVisibility(libraryQuery.columns, column, visible),
    });
  };

  const handleLifecycleAction = (demo: DemoSummary) => {
    void navigate(`/analysis?demo=${encodeURIComponent(demo.id)}`);
  };

  const handleReveal = async (demo: DemoSummary) => {
    if (!desktopShell || !demo.path || demo.lifecycle_status === 'missing') return;
    await revealAction.run(async () => {
      const revealed = await revealLocalPath(demo.path ?? '');
      if (!revealed) throw new Error(t('library.inspector.revealUnavailable'));
      return true;
    });
  };

  const handleScan = async () => {
    const result = await scanAction.run(() => commands.scanDemos(), msg("m0643"));
    if (result && source === 'service') await refreshDemos();
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
      async () => requireSuccessfulImport(await commands.importDemoPaths(paths), t),
      t('library.importSucceeded'),
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
    if (result && source === 'service') await refreshDemos();
  };

  const handleSave = async () => {
    if (!activeDemo) return;
    const updated = await saveAction.run(
      () => commands.updateDemo(activeDemo.id, { display_name: editName.trim(), remark: editRemark.trim() }),
      msg("m1163"),
    );
    if (!updated) return;
    setActiveDemo(updated);
    await refreshDemos();
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
    setActiveDemo(null);
    await refreshDemos();
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
        description={`${demos.length} / ${demoTotal} · ${t('library.description')}`}
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
      {revealAction.state.message ? (
        <Notice tone={revealAction.state.status === 'error' ? 'danger' : 'success'}>{revealAction.state.message}</Notice>
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
            value={libraryQuery.search}
            onChange={(event) => updateLibraryQuery({ search: event.target.value }, true)}
            placeholder={msg("m0668")}
            aria-label={msg("m0671")}
          />
          <kbd>/</kbd>
        </div>
        <div className="toolbar-divider" />
        <label className="compact-select">
          <Map size={14} />
          <input
            className="library-map-filter"
            list="library-map-options"
            value={libraryQuery.map}
            onChange={(event) => updateLibraryQuery({ map: event.target.value }, true)}
            placeholder={msg("m0231")}
            aria-label={msg("m0399")}
          />
          <datalist id="library-map-options">
            {maps.map((mapName) => <option key={mapName} value={mapName} />)}
          </datalist>
        </label>
        <label className="compact-select">
          <Filter size={14} />
          <select
            value={libraryQuery.status}
            onChange={(event) => updateLibraryQuery({ status: event.target.value as 'all' | DemoLifecycleStatus })}
            aria-label={msg("m0976")}
          >
            <option value="all">{msg("m0234")}</option>
            <option value="ready">{t('library.lifecycle.ready.label')}</option>
            <option value="analyzing">{t('library.lifecycle.analyzing.label')}</option>
            <option value="indexing">{t('library.lifecycle.indexing.label')}</option>
            <option value="discovered">{t('library.lifecycle.discovered.label')}</option>
            <option value="failed">{t('library.lifecycle.failed.label')}</option>
            <option value="missing">{t('library.lifecycle.missing.label')}</option>
          </select>
        </label>
        <div className="library-toolbar__spacer" />
        {view === 'table' ? (
          <LibraryColumnVisibility
            visibleColumns={visibleTableColumns}
            onChange={handleColumnVisibility}
          />
        ) : null}
        <SegmentedControl
          label={msg("m1106")}
          value={view}
          onChange={setView}
          options={[
            { value: 'table', label: t('library.view.table'), icon: <Table2 size={14} /> },
            { value: 'grid', label: msg("m1090"), icon: <Grid2X2 size={14} /> },
            { value: 'list', label: msg("m0281"), icon: <List size={14} /> },
          ]}
        />
      </Card>

      {source === 'service' && demos.length > 0 ? (
        <LibraryResultScope
          page={libraryQuery.page}
          pageSize={libraryQuery.pageSize}
          total={demoTotal}
          visible={demos.length}
        />
      ) : null}

      {selectedAnalysisIds.length > 0 ? (
        <div className="selection-bar">
          <CheckSquare size={16} />
          <strong>{msg("m0544")} {selectedAnalysisIds.length} {msg("m0403")}</strong>
          <Button size="sm" onClick={() => setSelectedIds(new Set())}>{msg("m0328")}</Button>
          <Button size="sm" variant="primary" onClick={() => {
            const ids = selectedAnalysisIds;
            const primary = ids[0];
            if (primary) void navigate(`/analysis?demo=${encodeURIComponent(primary)}&demos=${encodeURIComponent(ids.join(','))}`);
          }}>
            <Sparkles size={14} />{msg("m0644")}
          </Button>
        </div>
      ) : null}

      <div className="library-workspace">
        <section className="library-results" aria-label={t('library.localMatches')}>
          {view === 'table' ? (
            <LibraryPowerTable
              demos={demos}
              visibleColumns={visibleTableColumns}
              selectedIds={selectedIds}
              activeDemoId={activeDemo?.id ?? null}
              sort={tableSort}
              playingDemoId={playingDemoId}
              playbackDisabled={runtimeSession !== 'idle'}
              onSort={handleTableSort}
              onToggleSelected={toggleSelected}
              onOpenDetails={openDetails}
              onPlay={(demo) => void handlePlay(demo)}
              onLifecycleAction={handleLifecycleAction}
            />
          ) : (
          <div className={`demo-collection demo-collection--${view}`}>
            {demos.map((demo) => {
              const lifecycle = demoLifecyclePresentation(demo.lifecycle_status);
              return (
              <article
                className={`demo-card demo-card--${view}${selectedIds.has(demo.id) ? ' is-selected' : ''}`}
                key={demo.id}
              >
            <div className={`map-art map-art--${demo.map_name.replace('de_', '')}`}>
              <LibraryMapThumbnail mapName={demo.map_name} enabled={source === 'service' && lifecycle.showMatchSummary} />
              <span className="map-art__name">{demo.lifecycle_status === 'ready' ? demo.map_name.replace('de_', '').toUpperCase() : 'DEMO'}</span>
              <Badge tone={lifecycle.tone}>{t(lifecycle.labelKey)}</Badge>
              {isDemoAnalyzable(demo.lifecycle_status) ? <button
                type="button"
                className="demo-card__select"
                aria-label={msgf("m0089", [selectedIds.has(demo.id) ? msg("m0328") : msg("m1216"), demo.display_name])}
                aria-pressed={selectedIds.has(demo.id)}
                onClick={() => toggleSelected(demo)}
              >
                <span />
              </button> : null}
            </div>
            <div className="demo-card__body">
              <div className="demo-card__title">
                <div>
                  <h2>{demo.display_name}</h2>
                  <span>{demo.filename}</span>
                </div>
                <IconButton label={msg("m1086")} onClick={() => openDetails(demo)}><MoreHorizontal size={16} /></IconButton>
              </div>
              {hasVerifiedMatchScore(demo) ? <div className="scoreline">
                <div><span>{demo.team_a_name}</span><strong>{demo.score_team_a}</strong></div>
                <span>:</span>
                <div><strong>{demo.score_team_b}</strong><span>{demo.team_b_name}</span></div>
              </div> : demo.lifecycle_status === 'ready' ? null : <p className="demo-card__lifecycle">{t(lifecycle.descriptionKey)}</p>}
              {lifecycle.showMatchSummary ? <div className="demo-card__meta">
                <span><CalendarDays size={13} />{new Intl.DateTimeFormat(currentLocale(), { month: 'short', day: 'numeric' }).format(new Date(demo.played_at))}</span>
                <span><Clock3 size={13} />{duration(demo.duration_seconds)}</span>
                <span><Users size={13} />{demo.total_rounds} {msg("m0367")}</span>
              </div> : null}
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
                  {lifecycle.actionKey ? <Button
                    size="sm"
                    variant="primary"
                    disabled={!lifecycle.enabled}
                    onClick={() => void navigate(`/analysis?demo=${encodeURIComponent(demo.id)}`)}
                  >
                   {t(lifecycle.actionKey)}<ArrowRightIcon />
                  </Button> : null}
                </div>
              </div>
            </div>
              </article>
              );
            })}
          </div>
          )}

          {source === 'service' && demos.length === 0 ? (
            <div className="library-empty">
              <FileVideo2 size={26} />
              <h2>{msg("m0895")}</h2>
              <p>{msg("m1154")}</p>
              <Button onClick={() => updateLibraryQuery({ search: '', map: '', status: 'all' })}><RefreshCw size={14} />{msg("m0932")}</Button>
            </div>
          ) : null}
          {source === 'service' && demoTotal > 0 ? (
            <LibraryPagination
              page={libraryQuery.page}
              pageSize={libraryQuery.pageSize}
              total={demoTotal}
              onPageChange={(page) => updateLibraryQuery({ page })}
              onPageSizeChange={(pageSize) => updateLibraryQuery({ pageSize })}
            />
          ) : null}
        </section>
        {source === 'service' && demos.length > 0 ? (
          <div className="library-workspace-side">
            {activeDemo && wideInspector ? (
              <LibraryDemoInspector
                demo={activeDemo}
                playing={playingDemoId === activeDemo.id}
                playbackDisabled={playingDemoId !== null || runtimeSession !== 'idle'}
                revealDisabled={!desktopShell || !activeDemo.path || activeDemo.lifecycle_status === 'missing'}
                onPlay={(demo) => void handlePlay(demo)}
                onLifecycleAction={handleLifecycleAction}
                onReveal={(demo) => void handleReveal(demo)}
              />
            ) : (
              <LibraryWorkspaceSummary
                demos={demos}
                activeMap={libraryQuery.map}
                onMapFilter={(map) => updateLibraryQuery({ map: libraryQuery.map === map ? '' : map })}
              />
            )}
          </div>
        ) : null}
      </div>

      <Drawer
        open={activeDemo !== null && !wideInspector}
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
            <LibraryDemoInspector
              demo={activeDemo}
              playing={playingDemoId === activeDemo.id}
              playbackDisabled={playingDemoId !== null || runtimeSession !== 'idle'}
              revealDisabled={!desktopShell || !activeDemo.path || activeDemo.lifecycle_status === 'missing'}
              onPlay={(demo) => void handlePlay(demo)}
              onLifecycleAction={handleLifecycleAction}
              onReveal={(demo) => void handleReveal(demo)}
            />
            {saveAction.state.message ? (
              <Notice tone={saveAction.state.status === 'error' ? 'danger' : 'success'}>{saveAction.state.message}</Notice>
            ) : null}
            {activeDemo.lifecycle_status === 'ready' ? (
              <div className={`drawer-map-preview map-art--${activeDemo.map_name.replace('de_', '')}`}>
                <Map size={24} /><strong>{activeDemo.map_name.replace('de_', '').toUpperCase()}</strong>
              </div>
            ) : (
              <Notice tone={lifecycleNoticeTone(demoLifecyclePresentation(activeDemo.lifecycle_status).tone)}>
                {t(demoLifecyclePresentation(activeDemo.lifecycle_status).descriptionKey)}
              </Notice>
            )}
            <Field label={msg("m0726")}>
              <TextInput value={editName} onChange={(event) => setEditName(event.target.value)} maxLength={100} />
            </Field>
            <Field label={msg("m0415")} hint={msg("m1114")}>
              <textarea value={editRemark} onChange={(event) => setEditRemark(event.target.value)} rows={5} maxLength={1000} />
            </Field>
            {activeDemo.lifecycle_status === 'ready' ? <dl className="detail-list">
              <div><dt>{msg("m0396")}</dt><dd>{activeDemo.map_name}</dd></div>
              {hasVerifiedMatchScore(activeDemo) ? <div><dt>{msg("m0884")}</dt><dd>{activeDemo.score_team_a} : {activeDemo.score_team_b}</dd></div> : null}
              <div><dt>{msg("m0715")}</dt><dd>{duration(activeDemo.duration_seconds)}</dd></div>
              <div><dt>{msg("m0370")}</dt><dd>{activeDemo.total_rounds}</dd></div>
              <div><dt>{msg("m0813")}</dt><dd>{activeDemo.source}</dd></div>
            </dl> : null}
            {detailAnalysis ? (
              <div>
                <h3>{msg("m0443")}</h3>
                <div className="detail-list" role="table" aria-label={msg("m0443")}>
                  {detailAnalysis.players.map((player) => (
                    <div role="row" key={player.id}><dt role="cell">{player.name} · TEAM {player.team}</dt><dd role="cell">{player.kills} / {player.deaths} / {player.assists} · K/D {formatKillDeathRatioValue(player.kill_death_ratio, 2)} · ADR {player.adr.toFixed(1)}</dd></div>
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
