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
 * ## 需要服务
 *
 * 导入 / 分析 / 删除 / 监听目录 are all service-backed. They are disabled with
 * the reason written on them and the 「· 需要服务」 tail appended — never hidden
 * — via `pages/library/serviceAction`, which is a stand-in for
 * `app/boundary`'s `useServiceAction()` that §2.1 rule 3 puts out of a page's
 * reach. See that file's header.
 */

import { t } from '@lingui/core/macro';
import { Plural, Trans } from '@lingui/react/macro';
import { useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';

/*
 * Deep imports rather than `data/index.ts`. The barrel is a file every phase-3
 * agent would have to edit at once to re-export their own new hooks, and this
 * phase does not own it; §2.1's layer rule is about layers, not about barrels,
 * so `data/demos` and `data/config` are reached directly. Re-exporting them
 * from the barrel is a收口 step, not a correctness one.
 */
import { useAppConfig, useSetDemoWatchPaths } from '../data/config';
import {
  useDeleteDemos,
  useDemo,
  useDemoList,
  useDemoMetadata,
  useDemoWatchStatus,
  useImportDemoFiles,
  useLaunchDemoPlayback,
  useRescanDemoWatch,
  useReviewTags,
  useStartDemoAnalysis,
  useUpdateDemo,
  useUpdateDemoMetadataBatch,
} from '../data/demos';
import { dataErrorMessage } from '../data/errors';
import { useCreateAgentPlan } from '../data/plans';
import { useProjectCollections } from '../data/projectCollections';
import { Alert } from '../design/feedback';
import { OverflowMenu, Page, SelectionBar, Toolbar, useShellCollapsed } from '../design/layout';
import { Button, Seg } from '../design/primitives';
import type { DemoSummary } from '../shared/desktop/viewModels';
import { AddWatchDirectoryDialog } from './library/AddWatchDirectoryDialog';
import { ColumnConfigDialog } from './library/ColumnConfigDialog';
import { DeleteDemosDialog } from './library/DeleteDemosDialog';
import { ImportDemoDialog } from './library/ImportDemoDialog';
import { LibraryCards } from './library/LibraryCards';
import { LibraryFilters, type SavedLibraryView } from './library/LibraryFilters';
import { LibraryInspector } from './library/LibraryInspector';
import { LibraryTable } from './library/LibraryTable';
import { SaveViewDialog } from './library/SaveViewDialog';
import { WatchDirectoriesDrawer } from './library/WatchDirectoriesDrawer';
import { libraryColumns } from './library/libraryColumns';
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
} from './library/libraryQuery';
import { alsoDisabled, unavailableAction, useLibraryServiceAction } from './library/serviceAction';
import { HistoryWorkspace } from './HistoryPage';
import { RouteLink } from './RouteLink';

/** One overlay at a time — five dialogs and one drawer. */
type LibraryOverlay = 'import' | 'watch' | 'watch-add' | 'columns' | 'save-view' | 'delete' | null;

export function LibraryPage() {
  const [params] = useSearchParams();
  if (params.get('view') !== 'steam') return <DemoLibraryPage />;
  return (
    <Page
      scroll={false}
      toolbar={
        <Toolbar
          leading={<RouteLink to="/library"><Trans>‹ Demo 资料库</Trans></RouteLink>}
          title={<Trans>Steam 下载</Trans>}
          meta={<Trans>从 Steam 同步最近比赛并下载回放</Trans>}
        />
      }
    >
      <HistoryWorkspace embedded />
    </Page>
  );
}

function DemoLibraryPage() {
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const collapsed = useShellCollapsed();
  const service = useLibraryServiceAction();
  const createPlan = useCreateAgentPlan();
  const collections = useProjectCollections();

  const address = readLibraryAddress(params);
  const query = useMemo(() => libraryDemoQuery(address), [
    address.search, address.map, address.status, address.source, address.tagId,
    address.sort, address.page,
  ]);

  /* ── reads ─────────────────────────────────────────────────────────────── */

  const list = useDemoList(query);
  const tags = useReviewTags();
  const watch = useDemoWatchStatus();
  const config = useAppConfig();

  /* ── page state ────────────────────────────────────────────────────────── */

  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set<string>());
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
  const selectedDemos = rows.filter((demo) => selected.has(demo.id));

  /* ── writes ────────────────────────────────────────────────────────────── */

  const importDemos = useImportDemoFiles();
  const deleteDemos = useDeleteDemos();
  const startAnalysis = useStartDemoAnalysis();
  const launchPlayback = useLaunchDemoPlayback();
  const updateDemo = useUpdateDemo();
  const tagBatch = useUpdateDemoMetadataBatch();
  const setWatchPaths = useSetDemoWatchPaths();
  const rescan = useRescanDemoWatch();

  const watchPaths = config.data?.demo_watch_paths ?? [];
  const watchBusy = setWatchPaths.isPending || rescan.isPending;

  const setAddress = (change: Partial<LibraryAddress>) => {
    setParams(writeLibraryAddress(changeLibraryAddress(address, change)));
  };

  const analyse = (demoIds: readonly string[]) => {
    if (demoIds.length === 0) return;
    startAnalysis.mutate(demoIds);
  };

  const createProject = (demo: DemoSummary) => {
    void createPlan.mutateAsync({ title: demo.display_name, status: 'draft', shots: [], origin: null })
      .then((plan) => {
        const projectId = `plan:${plan.id}`;
        collections.add(projectId, {
          id: `${demo.id}:selection:match`, demoId: demo.id, matchLabel: demo.display_name,
          kind: 'selection', label: t`整场比赛`, round: null, playerId: null,
          highlightId: null, evidenceId: null, startTick: null, endTick: null,
          addedAt: new Date().toISOString(),
        });
        void navigate(`/projects/${encodeURIComponent(projectId)}?step=select`);
      })
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
        analyseButtonProps: alsoDisabled(service.buttonProps, startAnalysis.isPending),
        onCreateProject: createProject,
        createButtonProps: alsoDisabled(service.buttonProps, createPlan.isPending),
        serviceSuffix: service.suffix,
      }),
    [createPlan.isPending, service.buttonProps, service.suffix, startAnalysis.isPending],
  );

  const importAction = (
    <Button variant="primary" {...service.buttonProps} onClick={() => { setOverlay('import'); }}>
      <Trans>导入 Demo</Trans>
      {service.suffix}
    </Button>
  );

  const emptyActions = (
    <>
      {importAction}
      <Button {...service.buttonProps} onClick={() => { setOverlay('watch'); }}>
        <Trans>添加目录</Trans>
        {service.suffix}
      </Button>
    </>
  );

  const listError = dataErrorMessage(list.error);
  const actionError = dataErrorMessage(startAnalysis.error) ?? dataErrorMessage(launchPlayback.error);

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
          {...alsoDisabled(service.buttonProps, startAnalysis.isPending)}
          onClick={() => {
            analyse([...selected]);
          }}
        >
          <Plural value={selected.size} other="分析选中的 # 场" />
          {service.suffix}
        </Button>
      }
    >
      <OverflowMenu
        label={t`添加标签`}
        triggerLabel={<Trans>添加标签</Trans>}
        align="start"
        triggerClassName="h-[var(--h-ctl-sm)] border border-divider text-text"
        items={tags.data?.map((tag) => ({
          id: tag.id,
          label: tag.name,
          disabled: service.buttonProps.disabled || tagBatch.isPending,
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
      <Button
        size="sm"
        {...unavailableAction(t`导出会返回一份文件，桌面端还没有保存到磁盘的命令`)}
      >
        <Trans>导出元数据</Trans>
      </Button>
      <Button size="sm" variant="danger" {...service.buttonProps} onClick={() => { setOverlay('delete'); }}>
        <Trans>删除记录</Trans>
        {service.suffix}
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
      onOpenWorkspace={() => {
        if (activeDemo !== undefined) void navigate(`/match/${encodeURIComponent(activeDemo.id)}`);
      }}
      onAnalyse={() => {
        if (activeDemo !== undefined) analyse([activeDemo.id]);
      }}
      onPlay={() => {
        if (activeDemo !== undefined) launchPlayback.mutate(activeDemo.id);
      }}
      onSaveRemark={(remark) =>
        activeDemo === undefined
          ? Promise.resolve()
          : updateDemo.mutateAsync({ demoId: activeDemo.id, update: { remark } })
      }
      savingRemark={updateDemo.isPending}
      service={service.buttonProps}
      serviceSuffix={service.suffix}
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
                <Button variant="secondary" onClick={() => setParams({ view: 'steam' })}>
                  <Trans>Steam 下载</Trans>
                </Button>
              ),
              onSelect: () => setParams({ view: 'steam' }),
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
          mapNames={rows.map((demo) => demo.map_name)}
          tags={tags.data ?? []}
          savedViews={savedViews}
          onApplySavedView={(view) => {
            setParams(writeLibraryAddress(view.address));
          }}
          onSaveView={() => {
            setOverlay('save-view');
          }}
          onConfigureColumns={() => {
            setOverlay('columns');
          }}
        />
      }
      footer={collapsed ? inspector : undefined}
    >
      <div className="flex min-h-0 min-w-0 flex-1">
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          {actionError === null ? null : (
            <Alert
              className="m-4"
              variant="danger"
              action={{
                label: <Trans>重试</Trans>,
                onAction: () => {
                  const ids = startAnalysis.variables;
                  if (ids !== undefined) startAnalysis.mutate(ids);
                },
              }}
            >
              {actionError}
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
                setParams(writeLibraryAddress(clearLibraryFilters(address)));
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
                setParams(writeLibraryAddress(clearLibraryFilters(address)));
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
        service={service.buttonProps}
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
        service={service.buttonProps}
        serviceSuffix={service.suffix}
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
        service={service.buttonProps}
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
        service={service.buttonProps}
      />
    </Page>
  );
}
