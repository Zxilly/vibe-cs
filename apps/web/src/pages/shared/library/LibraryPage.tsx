/*
 * pages/ — 02 Demo 资料库 (spec §7 `/library?view=table|card`, phase 3b).
 *
 * The page fetches and orchestrates; every pixel belongs to `design/**` or to a
 * component under `pages/library/`. What lives *here* is the six decisions the
 * artboard makes that no component can make for it:
 *
 *   1. the address is the truth (`libraryQuery.ts`) — view, filters, sort and
 *      page all survive a reload and a pasted link (§4.4's rule, applied to the
 *      library)
 *   2. which of the two views is drawn, table or card
 *   3. what a selection can do, and that it is capped at 12 (the artboard's
 *      「上限 12 场」)
 *   4. which overlay is open — five of them, one at a time
 *   5. what every write invalidates — delegated wholesale to `data/demos.ts`
 *      and `data/config.ts`, which is where the `qk` factory is used
 *   6. where the Inspector goes at the §8 fold: `useShellCollapsed()` decides
 *      between the body row and the page footer, and the component itself does
 *      the folding (46px summary strip + drawer). No media query is written in
 *      this file.
 *
 * ## Three states, everywhere
 *
 * Loading is a `TableSkeleton` with no invented percentage, empty is an
 * `Empty` with a real recovery action, and a failure is a `Notice` in
 * place — 「补齐 · 规范与状态」: 「不用 Toast 承载错误」. Each of the five
 * overlays renders its own failure beside its own confirm button, because that
 * is where the retry belongs.
 *
 */

import { t } from '@lingui/core/macro';
import { Plural, Trans } from '@lingui/react/macro';
import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';

/*
 * Deep imports rather than `data/index.ts`. The barrel is a file every phase-3
 * agent would have to edit at once to re-export their own new hooks, and this
 * phase does not own it; §2.1's layer rule is about layers, not about barrels,
 * so `data/demos` and `data/config` are reached directly. Re-exporting them
 * from the barrel is a收口 step, not a correctness one.
 */
import { useAppConfig, useSetDemoWatchPaths } from '../../../data/config';
import {
  useDeleteDemos,
  useDemo,
  useDemoList,
  useDemoMapNames,
  useDemoMetadata,
  useDemoWatchStatus,
  useExportDemoMetadata,
  useImportDemoPaths,
  useLaunchDemoPlayback,
  useRescanDemoWatch,
  useReviewTags,
  useStartDemoAnalysis,
  useUpdateDemo,
  useUpdateDemoMetadataBatch,
} from '../../../data/demos';
import { dataErrorMessage } from '../../../data/errors';
import { useNativeShell, useNativeShellAction, useRevealPath } from '../../../data/nativeShell';
import { Alert, toast } from '../../../design/feedback';
import { OverflowMenu, Page, SelectionBar, Toolbar, useShellCollapsed } from '../../../design/layout';
import { Button, Seg } from '../../../design/primitives';
import { useCreateDemoProject } from '../../../domain/project/createDemoProject';
import type { DemoSummary } from '../../../shared/desktop/viewModels';
import { AddWatchDirectoryDialog } from './AddWatchDirectoryDialog';
import { ColumnConfigDialog } from './ColumnConfigDialog';
import { DeleteDemosDialog } from './DeleteDemosDialog';
import { ImportDemoDialog } from './ImportDemoDialog';
import { LibraryCards } from './LibraryCards';
import { LibraryFilters, type SavedLibraryView } from './LibraryFilters';
import { LibraryInspector } from './LibraryInspector';
import { LibraryTable } from './LibraryTable';
import { SaveViewDialog } from './SaveViewDialog';
import { WatchDirectoriesDrawer } from './WatchDirectoriesDrawer';
import { libraryColumns } from './libraryColumns';
import {
  changeLibraryAddress,
  clearLibraryFilters,
  demoSortOf,
  DEMO_SELECTION_LIMIT,
  hasActiveFilter,
  libraryDemoQuery,
  readLibraryAddress,
  sortStateOf,
  writeLibraryAddress,
  type LibraryAddress,
  type LibraryView,
} from './libraryQuery';
import { HistoryWorkspace } from './history/HistoryPage';

/** One overlay at a time — five dialogs and one drawer. */
type LibraryOverlay = 'import' | 'watch' | 'watch-add' | 'columns' | 'save-view' | 'delete' | null;

export function LibraryPage() {
  const [params, setParams] = useSearchParams();
  if (params.get('view') !== 'steam') return <DemoLibraryPage />;
  const returnToLibrary = () => {
    const next = new URLSearchParams();
    const projectId = params.get('project');
    if (projectId !== null) next.set('project', projectId);
    setParams(next);
  };
  return (
    <Page
      scroll={false}
      toolbar={
        <Toolbar
          title={<Trans>Steam 下载</Trans>}
          meta={<Trans>从 Steam 同步最近比赛并下载回放</Trans>}
          actions={[{
            id: 'library',
            label: <Trans>返回 Demo 资料库</Trans>,
            onSelect: returnToLibrary,
            control: <Button onClick={returnToLibrary}><Trans>返回 Demo 资料库</Trans></Button>,
          }]}
        />
      }
    >
      <HistoryWorkspace embedded />
    </Page>
  );
}

function DemoLibraryPage() {
  const [params, setParams] = useSearchParams();
  const preferredProjectId = params.get('project');
  const navigate = useNavigate();
  const collapsed = useShellCollapsed();
  const demoProject = useCreateDemoProject();
  const nativeShell = useNativeShell();
  const shellAction = useNativeShellAction();
  const revealPath = useRevealPath();

  const address = readLibraryAddress(params);
  const query = useMemo(() => libraryDemoQuery(address), [
    address.search, address.map, address.status, address.source, address.tagId,
    address.sort, address.page,
  ]);

  /* ── reads ─────────────────────────────────────────────────────────────── */

  const list = useDemoList(query);
  const mapNames = useDemoMapNames();
  const tags = useReviewTags();
  const watch = useDemoWatchStatus();
  const config = useAppConfig();

  /* ── page state ────────────────────────────────────────────────────────── */

  const [selectedIds, setSelected] = useState<ReadonlySet<string>>(new Set<string>());
  const [activeDemoId, setActiveDemoId] = useState<string | null>(null);
  const [hiddenColumns, setHiddenColumns] = useState<ReadonlySet<string>>(new Set<string>());
  // §4.2 wants saved views in the persisted store; that store is `shared/**`
  // and this phase does not own it. See `SaveViewDialog`'s header.
  const [savedViews, setSavedViews] = useState<readonly SavedLibraryView[]>([]);
  const [overlay, setOverlay] = useState<LibraryOverlay>(null);

  const activeDetail = useDemo(activeDemoId);
  const activeMetadata = useDemoMetadata(activeDemoId);

  const rows = list.data?.items ?? [];
  const activeRow = rows.find((demo) => demo.id === activeDemoId);
  const activeDemo = activeDetail.data ?? activeRow;
  const selectedDemos = rows.filter((demo) => selectedIds.has(demo.id));
  const selected = new Set(selectedDemos.map((demo) => demo.id));

  // Batch actions belong to this query. A new filter or page must not keep
  // invisible records selected, including when the user later returns.
  useEffect(() => {
    setSelected(new Set<string>());
  }, [query]);

  // The inspector is part of the library's scanning workflow, not an empty
  // decoration. Keep it on the first visible match until the user activates a
  // different row, and recover naturally when filtering removes that row.
  useEffect(() => {
    const next = rows[0]?.id ?? null;
    if (activeDemoId === null || !rows.some((demo) => demo.id === activeDemoId)) {
      setActiveDemoId(next);
    }
  }, [activeDemoId, rows]);

  /* ── writes ────────────────────────────────────────────────────────────── */

  const importDemos = useImportDemoPaths();
  const deleteDemos = useDeleteDemos();
  const startAnalysis = useStartDemoAnalysis();
  const launchPlayback = useLaunchDemoPlayback();
  const updateDemo = useUpdateDemo();
  const tagBatch = useUpdateDemoMetadataBatch();
  const setWatchPaths = useSetDemoWatchPaths();
  const rescan = useRescanDemoWatch();
  const exportMetadata = useExportDemoMetadata();

  const watchPaths = config.data?.demo_watch_paths ?? [];
  const watchBusy = setWatchPaths.isPending || rescan.isPending;

  const setLibraryAddress = (nextAddress: LibraryAddress) => {
    const next = writeLibraryAddress(nextAddress);
    if (preferredProjectId !== null) next.set('project', preferredProjectId);
    setParams(next);
  };
  const setAddress = (change: Partial<LibraryAddress>) => {
    setLibraryAddress(changeLibraryAddress(address, change));
  };
  const openSteam = () => {
    const next = new URLSearchParams({ view: 'steam' });
    if (preferredProjectId !== null) next.set('project', preferredProjectId);
    setParams(next);
  };

  /*
   * 「导出元数据」: the rows the current filters match, as one JSON file the
   * user places with the shell's save dialog. A toast rather than a Notice for
   * the outcome, as `useRevealPath` does: the retry is the same click, and a
   * box that outlives the question would say nothing more.
   */
  const exportToFile = () => {
    void exportMetadata
      .mutateAsync({ format: 'json', query })
      .then((bytes) =>
        nativeShell.saveBytes({
          title: t`导出资料库元数据`,
          defaultFileName: `demo-library-${new Date().toISOString().slice(0, 10)}.json`,
          filters: [{ name: 'JSON', extensions: ['json'] }],
          bytes: new Uint8Array(bytes),
        }),
      )
      .then((path) => {
        if (path !== null) toast.success(t`元数据已导出`, { description: path });
      })
      .catch((error: unknown) => {
        toast.error(t`元数据没能导出`, { description: dataErrorMessage(error) ?? undefined });
      });
  };

  const analyse = (demoIds: readonly string[]) => {
    if (demoIds.length === 0) return;
    startAnalysis.mutate(demoIds);
  };

  const createProject = (demos: readonly DemoSummary[]) => {
    if (demos.length === 0) return;
    void demoProject.create(demos)
      .then((project) => void navigate(`/projects/${encodeURIComponent(project.id)}`))
      .catch(() => undefined);
  };

  const setWatchDirectories = async (paths: readonly string[]) => {
    const current = config.data;
    if (current === undefined) throw new Error(t`配置还没读出来，稍后再试`);
    await setWatchPaths.mutateAsync({ config: current, paths });
  };

  /* ── the pieces ────────────────────────────────────────────────────────── */

  const columns = useMemo(
    () =>
      libraryColumns({
        onAnalyse: (demo: DemoSummary) => {
          analyse([demo.id]);
        },
        analyseButtonProps: { disabled: startAnalysis.isPending },
        onCreateProject: (demo: DemoSummary) => createProject([demo]),
        createButtonProps: { disabled: demoProject.pending },
        workspaceHref: (demo: DemoSummary) => {
          const target = `/match/${encodeURIComponent(demo.id)}`;
          return preferredProjectId === null
            ? target
            : `${target}?${new URLSearchParams({ view: 'replay', project: preferredProjectId }).toString()}`;
        },
      }),
    [demoProject.pending, preferredProjectId, startAnalysis.isPending],
  );

  const importAction = (
    <Button variant="primary" onClick={() => { setOverlay('import'); }}>
      <Trans>导入 Demo</Trans>
    </Button>
  );

  const emptyActions = (
    <>
      {importAction}
      <Button onClick={() => { setOverlay('watch'); }}>
        <Trans>添加目录</Trans>
      </Button>
    </>
  );

  const listError = dataErrorMessage(list.error);
  const analysisError = dataErrorMessage(startAnalysis.error);
  const playbackError = dataErrorMessage(launchPlayback.error);
  const createProjectError = dataErrorMessage(demoProject.error);

  const selectionBar = (
    <SelectionBar
      summary={
        <Trans>
          已选 {selected.size} 场 · 上限 {DEMO_SELECTION_LIMIT} 场
        </Trans>
      }
      primary={
        <Button
          variant="primary"
          size="sm"
          disabled={startAnalysis.isPending}
          onClick={() => {
            analyse([...selected]);
          }}
        >
          <Plural value={selected.size} other="分析选中的 # 场" />
        </Button>
      }
    >
      <Button size="sm" variant="ghost" onClick={(event) => {
        // Return to the table's keyboard tab stop before this footer unmounts.
        event.currentTarget.closest('[data-library-table]')
          ?.querySelector<HTMLElement>('tbody tr[tabindex="0"]')?.focus();
        setSelected(new Set<string>());
      }}>
        <Trans>取消选择</Trans>
      </Button>
      <Button
        size="sm"
        disabled={demoProject.pending}
        onClick={() => createProject(selectedDemos)}
      >
        <Trans>用 Agent 创作</Trans>
      </Button>
      <OverflowMenu
        label={t`添加标签`}
        triggerLabel={<Trans>添加标签</Trans>}
        align="start"
        triggerClassName="h-[var(--h-ctl-sm)] border border-divider text-text"
        items={tags.data?.map((tag) => ({
          id: tag.id,
          label: tag.name,
          disabled: tagBatch.isPending,
          onSelect: () => {
            tagBatch.mutate({
              demo_ids: [...selected],
              set_match_source: false,
              match_source: null,
              add_tag_ids: [tag.id],
              remove_tag_ids: [],
            });
          },
        })) ?? []}
      />
      {/* No 「导出元数据」 here: the export is query-shaped (`/demos/export`
          takes the filters, not ids), so it lives on the filter strip where
          the filters are. A per-selection export would be a second wire. */}
      <Button size="sm" variant="danger" onClick={() => { setOverlay('delete'); }}>
        <Trans>删除记录</Trans>
      </Button>
    </SelectionBar>
  );

  const inspector = (
    <LibraryInspector
      demo={activeDemo}
      metadata={activeMetadata.data}
      loading={activeDetail.isLoading}
      error={dataErrorMessage(activeDetail.error)}
      onRetry={() => {
        void activeDetail.refetch();
      }}
      analysing={activeDemo?.lifecycle_status === 'analyzing'}
      // A project sent the user here to collect clips (`?project=`), or they
      // came on their own: the same match workspace, named for the job.
      workspaceLabel={
        preferredProjectId === null ? <Trans>打开比赛工作区</Trans> : <Trans>从 Demo 创建剪辑</Trans>
      }
      onOpenWorkspace={() => {
        if (activeDemo === undefined) return;
        const target = new URLSearchParams({ view: 'replay' });
        if (preferredProjectId !== null) target.set('project', preferredProjectId);
        void navigate(`/match/${encodeURIComponent(activeDemo.id)}?${target.toString()}`);
      }}
      onAnalyse={() => {
        if (activeDemo !== undefined) analyse([activeDemo.id]);
      }}
      onViewAnalysis={() => {
        void navigate('/tasks');
      }}
      onPlay={() => {
        if (activeDemo !== undefined) launchPlayback.mutate(activeDemo.id);
      }}
      onReveal={() => {
        if (activeDemo !== undefined) revealPath(activeDemo.path);
      }}
      revealButtonProps={shellAction.buttonProps}
      onSaveRemark={(remark) =>
        activeDemo === undefined
          ? Promise.resolve()
          : updateDemo.mutateAsync({ demoId: activeDemo.id, update: { remark } })
      }
      savingRemark={updateDemo.isPending}
    />
  );

  /* ── the page ──────────────────────────────────────────────────────────── */

  return (
    <Page
      scroll={false}
      toolbar={
        <Toolbar
          title={<Trans>Demo 资料库</Trans>}
          meta={
            <>
              <Plural value={list.data?.total ?? 0} other="# 场" />
              {' · '}
              <Plural value={watch.data?.roots.length ?? 0} other="# 个监听目录" />
            </>
          }
          // §10.3 缺口 2: a short-titled page keeps two actions on the bar when
          // collapsed. Here that is the view switch and 监听目录; 导入 Demo is
          // `primary` and never folds at all (§8).
          inlineActionsWhenCollapsed={2}
          actions={[
            {
              id: 'steam',
              label: <Trans>Steam 下载</Trans>,
              control: (
                <Button variant="secondary" onClick={openSteam}>
                  <Trans>Steam 下载</Trans>
                </Button>
              ),
              onSelect: openSteam,
            },
            {
              id: 'view',
              label: <Trans>切换视图</Trans>,
              control: (
                <Seg<LibraryView>
                  name="library-view"
                  aria-label={t`视图`}
                  value={address.view}
                  options={[
                    { value: 'table', label: t`表格` },
                    { value: 'card', label: t`卡片` },
                  ]}
                  onChange={(view) => {
                    setAddress({ view });
                  }}
                />
              ),
            },
            {
              id: 'watch',
              label: <Trans>监听目录</Trans>,
              onSelect: () => {
                setOverlay('watch');
              },
              control: (
                <Button onClick={() => { setOverlay('watch'); }}>
                  <Trans>监听目录</Trans>
                </Button>
              ),
            },
          ]}
          primary={importAction}
        />
      }
      bar={
        <LibraryFilters
          address={address}
          onChange={setAddress}
          mapNames={mapNames.data ?? []}
          tags={tags.data ?? []}
          savedViews={savedViews}
          onApplySavedView={(view) => {
            setLibraryAddress(view.address);
          }}
          onSaveView={() => {
            setOverlay('save-view');
          }}
          onConfigureColumns={() => {
            setOverlay('columns');
          }}
          onExport={exportToFile}
          exportButtonProps={
            exportMetadata.isPending ? { disabled: true } : shellAction.buttonProps
          }
        />
      }
      footer={collapsed ? inspector : undefined}
    >
      <div className="flex min-h-0 min-w-0 flex-1">
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          {analysisError === null ? null : (
            <Alert
              className="m-4"
              variant="danger"
              action={{
                label: <Trans>重试</Trans>,
                disabled: startAnalysis.isPending,
                onAction: () => {
                  const ids = startAnalysis.variables;
                  if (ids !== undefined) startAnalysis.mutate(ids);
                },
              }}
            >
              {analysisError}
            </Alert>
          )}
          {playbackError === null ? null : (
            <Alert
              className="m-4"
              variant="danger"
              action={{
                label: <Trans>重试回放</Trans>,
                disabled: launchPlayback.isPending,
                onAction: () => {
                  const demoId = launchPlayback.variables;
                  if (demoId !== undefined) launchPlayback.mutate(demoId);
                },
              }}
            >
              {playbackError}
            </Alert>
          )}
          {createProjectError === null ? null : (
            <Alert
              className="m-4"
              variant="danger"
              action={{ label: <Trans>查看作品</Trans>, onAction: () => void navigate('/projects') }}
              detail={<Trans>若作品已创建，可从作品列表打开并继续添加素材。</Trans>}
            >
              {createProjectError}
            </Alert>
          )}

          {address.view === 'table' ? (
            <LibraryTable
              columns={columns}
              page={list.data}
              loading={list.isLoading}
              error={listError}
              onRetry={() => {
                void list.refetch();
              }}
              hiddenColumns={hiddenColumns}
              sort={sortStateOf(address.sort)}
              onSortChange={(next) => {
                setAddress({ sort: demoSortOf(next) });
              }}
              selected={selected}
              onSelectedChange={setSelected}
              activeDemoId={activeDemoId}
              onRowActivate={(demo) => {
                setActiveDemoId(demo.id);
              }}
              currentPage={address.page}
              onPageChange={(page) => {
                setAddress({ page });
              }}
              filtered={hasActiveFilter(address)}
              onClearFilters={() => {
                setLibraryAddress(clearLibraryFilters(address));
              }}
              emptyActions={emptyActions}
              selectionBar={selectionBar}
            />
          ) : (
            <LibraryCards
              page={list.data}
              loading={list.isLoading}
              error={listError}
              onRetry={() => {
                void list.refetch();
              }}
              activeDemoId={activeDemoId}
              onActivate={(demo) => {
                setActiveDemoId(demo.id);
              }}
              currentPage={address.page}
              onPageChange={(page) => {
                setAddress({ page });
              }}
              filtered={hasActiveFilter(address)}
              onClearFilters={() => {
                setLibraryAddress(clearLibraryFilters(address));
              }}
              emptyActions={emptyActions}
            />
          )}
        </div>

        {collapsed ? null : inspector}
      </div>

      {/* ── the five overlays ──────────────────────────────────────────── */}

      <ImportDemoDialog
        open={overlay === 'import'}
        onClose={() => {
          setOverlay(null);
        }}
        onImport={(files) => importDemos.mutateAsync(files)}
        importing={importDemos.isPending}
        error={dataErrorMessage(importDemos.error)}
      />

      <WatchDirectoriesDrawer
        open={overlay === 'watch'}
        onClose={() => {
          setOverlay(null);
        }}
        status={watch.data}
        loading={watch.isLoading}
        error={dataErrorMessage(watch.error) ?? dataErrorMessage(setWatchPaths.error)}
        onRetry={() => {
          void watch.refetch();
        }}
        onAdd={() => {
          setOverlay('watch-add');
        }}
        onRemove={(path) => {
          void setWatchDirectories(watchPaths.filter((entry) => entry !== path));
        }}
        onRescan={() => {
          rescan.mutate();
        }}
        busy={watchBusy}
      />

      <AddWatchDirectoryDialog
        open={overlay === 'watch-add'}
        onClose={() => {
          setOverlay('watch');
        }}
        existingPaths={watchPaths}
        onAdd={(path) => setWatchDirectories([...watchPaths, path])}
        saving={setWatchPaths.isPending}
        error={dataErrorMessage(setWatchPaths.error)}
      />

      <ColumnConfigDialog
        open={overlay === 'columns'}
        onClose={() => {
          setOverlay(null);
        }}
        columns={columns}
        hidden={hiddenColumns}
        onApply={setHiddenColumns}
      />

      <SaveViewDialog
        open={overlay === 'save-view'}
        onClose={() => {
          setOverlay(null);
        }}
        existingNames={savedViews.map((view) => view.name)}
        onSave={(name) => {
          setSavedViews([...savedViews, { name, address }]);
        }}
      />

      <DeleteDemosDialog
        open={overlay === 'delete'}
        onClose={() => {
          setOverlay(null);
        }}
        demos={selectedDemos}
        onDelete={async () => {
          await deleteDemos.mutateAsync([...selected]);
          setSelected(new Set<string>());
          if (activeDemoId !== null && selected.has(activeDemoId)) setActiveDemoId(null);
        }}
        deleting={deleteDemos.isPending}
        error={dataErrorMessage(deleteDemos.error)}
      />
    </Page>
  );
}
