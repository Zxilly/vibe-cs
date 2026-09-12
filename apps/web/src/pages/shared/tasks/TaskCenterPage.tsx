import { t } from '@lingui/core/macro';
import { Trans } from '@lingui/react/macro';
import { useState } from 'react';

import { dataErrorMessage } from '../../../data/errors';
import { useTaskFeed } from '../../../data/tasks';
import { Page, useCollapsed } from '../../../design/layout';
import { Button, Seg } from '../../../design/primitives';
import { TaskActivityList } from '../../../domain/task/TaskActivityList';
import { TaskDetailBody } from '../../../domain/task/TaskDetailBody';
import { TASK_POLL_FEED_MS } from '../../../domain/task/taskPolling';
import { useTaskActions } from '../../../domain/task/useTaskActions';
import type { ActivityStateFilter } from '../../../shared/desktop/dto';
import { RouteLink } from '../navigation/RouteLink';

type TaskFilter = 'all' | ActivityStateFilter;

export function TaskCenterPage() {
  const [state, setState] = useState<TaskFilter>('all');
  const [page, setPage] = useState(1);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const collapsed = useCollapsed(undefined);
  const feed = useTaskFeed({ page, page_size: 20, ...(state === 'all' ? {} : { state }) }, {
    pollWhileActiveMs: TASK_POLL_FEED_MS,
  });
  const bind = useTaskActions();
  const items = feed.data?.items ?? [];
  const selected = items.find((item) => item.id === selectedId) ?? items.find((item) => item.status === 'failed') ?? null;

  return (
    <Page scroll={false} bar={
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
        <Button size="sm" variant="ghost" onClick={() => void feed.refetch()}><Trans>刷新</Trans></Button>
      </div>
    } footer={
      <div className="flex flex-none justify-end gap-2 border-t border-divider px-4 py-2">
        <Button size="sm" variant="ghost" disabled={page === 1} onClick={() => setPage((value) => value - 1)}><Trans>上一页</Trans></Button>
        <span className="self-center font-mono text-xs">{page}</span>
        <Button size="sm" variant="ghost" disabled={feed.isPending || page * 20 >= (feed.data?.total ?? 0)} onClick={() => setPage((value) => value + 1)}><Trans>下一页</Trans></Button>
      </div>
    }>
      <div className="flex min-h-0 min-w-0 flex-1 gap-4 p-4" data-task-center>
        <main className="min-h-0 min-w-0 flex-1 overflow-y-auto">
          <TaskActivityList
            items={items}
            total={feed.data?.total ?? 0}
            firstItem={(page - 1) * 20 + 1}
            selectedId={selected?.id ?? null}
            isLoading={feed.isPending}
            error={feed.isError ? dataErrorMessage(feed.error) ?? t`读取任务失败` : null}
            onReload={() => void feed.refetch()}
            bind={bind}
            onSelect={setSelectedId}
          />
          {collapsed && selected !== null ? <RouteLink className="mt-3" to={`/tasks/${encodeURIComponent(selected.id)}`}><Trans>打开任务详情</Trans></RouteLink> : null}
        </main>
        {collapsed || selected === null ? null : (
          <aside className="w-[var(--w-inspector)] flex-none overflow-y-auto rounded-lg border border-divider bg-bg" aria-label={t`任务详情`}>
            <TaskDetailBody item={selected} compact />
          </aside>
        )}
      </div>
    </Page>
  );
}
