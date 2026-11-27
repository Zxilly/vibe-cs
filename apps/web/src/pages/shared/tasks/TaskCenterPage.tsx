import { t } from '@lingui/core/macro';
import { Trans } from '@lingui/react/macro';
import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';

import { useDemo } from '../../../data/demos';
import { dataErrorMessage } from '../../../data/errors';
import { useTaskFeed } from '../../../data/tasks';
import { Alert, Drawer } from '../../../design/feedback';
import { clampPage, Empty, Pagination } from '../../../design/data';
import { Page, Toolbar, useCollapsed } from '../../../design/layout';
import { Button, Seg } from '../../../design/primitives';
import { TaskActivityList } from '../../../domain/task/TaskActivityList';
import { TaskDetailBody } from '../../../domain/task/TaskDetailBody';
import { TASK_POLL_FEED_MS } from '../../../domain/task/taskPolling';
import { TASK_CENTER_STATES, useTaskActions } from '../../../domain/task/useTaskActions';
import type { ActivityStateFilter } from '../../../shared/desktop/dto';
import { pickQueryValue } from '../navigation/routeQuery';

type TaskFilter = 'all' | ActivityStateFilter;

const TASK_FILTERS: readonly TaskFilter[] = ['all', ...TASK_CENTER_STATES];

/**
 * Two layouts, one detail body. Wide: the list beside a resident inspector,
 * which falls back to the first failed task so the panel is never blank.
 * Narrow (the ≤1100px fold): there is no room beside the list, so 查看详情
 * opens the same body in a right-hand overlay — the fold the workspace uses for
 * its Agent panel — and nothing opens until the reader asks.
 *
 * `?demo=` narrows the list to one Demo's analysis runs: links that start from
 * a single Demo (the library row and inspector, the match workspace) carry it,
 * so 「查看失败原因」 lands on that Demo's run and not on whatever else failed.
 * It is read through the existing feed query — `kind=analysis` plus the Demo
 * id, which the service writes into every analysis row's search text — and
 * the page says so above the list, with the way back to every task.
 */
export function TaskCenterPage() {
  /* The filter lives in `?state=` so links from the library, the match
     workspace and the workbench open the list on the records they mean, and
     it survives going into a task and back. An unknown value reads as 全部. */
  const [searchParams, setSearchParams] = useSearchParams();
  const state = pickQueryValue(searchParams.get('state'), TASK_FILTERS, 'all');
  const demoId = searchParams.get('demo') || null;
  const demo = useDemo(demoId);
  const demoName = demo.data?.display_name ?? null;
  const setState = (next: TaskFilter) => {
    setSearchParams((current) => {
      const params = new URLSearchParams(current);
      if (next === 'all') params.delete('state');
      else params.set('state', next);
      return params;
    }, { replace: true });
  };
  const [page, setPage] = useState(1);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const collapsed = useCollapsed(undefined);
  const feed = useTaskFeed({
    page,
    page_size: 20,
    ...(state === 'all' ? {} : { state }),
    ...(demoId === null ? {} : { kind: 'analysis' as const, search: demoId }),
  }, {
    pollWhileActiveMs: TASK_POLL_FEED_MS,
  });
  const bind = useTaskActions();
  const items = feed.data?.items ?? [];
  const chosen = items.find((item) => item.id === selectedId) ?? null;
  const selected = chosen ?? (collapsed ? null : items.find((item) => item.status === 'failed') ?? null);
  const showAll = () => { setState('all'); setPage(1); setSelectedId(null); };
  const showAllTasks = () => { setSearchParams(new URLSearchParams()); setPage(1); setSelectedId(null); };
  const validPage = feed.isSuccess ? clampPage(page, feed.data.total, 20) : page;
  useEffect(() => {
    if (validPage === page) return;
    setPage(validPage);
    setSelectedId(null);
  }, [page, validPage]);

  return (
    <Page scroll={false} toolbar={<Toolbar title={<Trans>任务中心</Trans>} />} bar={
      <div className="flex flex-none flex-wrap items-center justify-between gap-3 border-b border-divider bg-surface-chrome px-4 py-2">
        <Seg<TaskFilter>
          name="task-state"
          aria-label={t`任务状态`}
          value={state}
          onChange={(next) => { setState(next); setPage(1); setSelectedId(null); }}
          options={[
            { value: 'all', label: <Trans>全部</Trans> },
            { value: 'active', label: <Trans>进行中</Trans> },
            { value: 'failed', label: <Trans>失败</Trans> },
            { value: 'completed', label: <Trans>已完成</Trans> },
            { value: 'cancelled', label: <Trans>已取消</Trans> },
          ]}
        />
        <Button size="sm" variant="ghost" disabled={feed.isFetching} onClick={() => void feed.refetch()}>
          {feed.isFetching ? <Trans>正在刷新</Trans> : <Trans>刷新</Trans>}
        </Button>
      </div>
    } footer={
      feed.isPending ? null : <Pagination page={page} pageSize={20} total={feed.data?.total ?? 0}
        onPageChange={(next) => { setPage(next); setSelectedId(null); }} />
    }>
      <div className="flex min-h-0 min-w-0 flex-1 gap-4 p-4" data-task-center>
        <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-3 overflow-y-auto">
          {demoId === null ? null : (
            <Alert variant="info" action={{ label: <Trans>查看全部任务</Trans>, onAction: showAllTasks }}>
              {demoName === null
                ? <Trans>只显示这个 Demo 的分析任务。</Trans>
                : <Trans>只显示「{demoName}」的分析任务。</Trans>}
            </Alert>
          )}
          <TaskActivityList
            items={items}
            total={feed.data?.total ?? 0}
            firstItem={(page - 1) * 20 + 1}
            selectedId={selected?.id ?? null}
            isLoading={feed.isPending || validPage !== page}
            error={feed.isError ? dataErrorMessage(feed.error) ?? t`读取任务失败` : null}
            onReload={() => void feed.refetch()}
            bind={bind}
            onSelect={setSelectedId}
            hasSideDetail={!collapsed && selected !== null}
            {...(state === 'all' ? {} : { filter: { state, onClear: showAll } })}
            {...(demoId === null ? {} : {
              empty: (
                <Empty
                  title={state === 'all'
                    ? <Trans>这个 Demo 还没有分析任务</Trans>
                    : <Trans>这个 Demo 没有符合当前状态的分析任务</Trans>}
                  actions={
                    <Button variant="secondary" size="sm" onClick={showAllTasks}>
                      <Trans>查看全部任务</Trans>
                    </Button>
                  }
                />
              ),
            })}
          />
        </div>
        {collapsed ? (
          <Drawer
            open={chosen !== null}
            title={<Trans>任务详情</Trans>}
            onClose={() => setSelectedId(null)}
            width="wide"
          >
            {chosen === null ? null : <TaskDetailBody item={chosen} compact />}
          </Drawer>
        ) : selected === null ? null : (
          <aside className="w-[var(--w-inspector)] flex-none overflow-y-auto rounded-lg border border-divider bg-bg" aria-label={t`任务详情`}>
            <TaskDetailBody item={selected} compact />
          </aside>
        )}
      </div>
    </Page>
  );
}
