import { t } from '@lingui/core/macro';
import { Trans } from '@lingui/react/macro';
import { useEffect, useRef, useState } from 'react';

import { dataErrorMessage } from './data/errors';
import { useServiceAction } from './data/serviceAction';
import { useTaskFeed } from './data/tasks';
import { Empty } from './design/data';
import { Alert, Drawer } from './design/feedback';
import { Button } from './design/primitives';
import { TaskCard, TaskCardSkeleton } from './domain/task';
import { TaskDetailBody } from './pages/delivery/TaskDetailBody';
import { TASK_POLL_FEED_MS } from './pages/delivery/taskPolling';
import { useTaskActions } from './pages/delivery/useTaskActions';
import type { ActivityItem } from './shared/desktop/viewModels';
import {
  activityStatusChanges,
  activityStatusSnapshot,
  type ActivityStatusSnapshot,
} from './activityUnread';

export interface ActivityDrawerProps {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly onUnreadChange: (count: number) => void;
}

const GROUPS = [
  { id: 'active', label: <Trans>进行中</Trans>, includes: (item: ActivityItem) => !['completed', 'failed', 'cancelled'].includes(item.status) },
  { id: 'failed', label: <Trans>失败</Trans>, includes: (item: ActivityItem) => item.status === 'failed' },
  { id: 'completed', label: <Trans>已完成</Trans>, includes: (item: ActivityItem) => item.status === 'completed' },
  { id: 'cancelled', label: <Trans>已取消</Trans>, includes: (item: ActivityItem) => item.status === 'cancelled' },
] as const;

export function ActivityDrawer({ open, onClose, onUnreadChange }: ActivityDrawerProps) {
  const feed = useTaskFeed({ page: 1, page_size: 50 }, { pollWhileActiveMs: TASK_POLL_FEED_MS });
  const service = useServiceAction();
  const bind = useTaskActions({ service });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [unread, setUnread] = useState(0);
  const previous = useRef<ActivityStatusSnapshot | null>(null);

  const items = feed.data?.items ?? [];
  const selected = items.find((item) => item.id === selectedId) ?? null;

  useEffect(() => {
    if (feed.data === undefined) return;
    const changes = activityStatusChanges(previous.current, feed.data.items);
    previous.current = activityStatusSnapshot(feed.data.items);
    setUnread((current) => (open ? 0 : current + changes));
  }, [feed.data, open]);

  useEffect(() => {
    onUnreadChange(unread);
  }, [onUnreadChange, unread]);

  useEffect(() => {
    if (!open) setSelectedId(null);
  }, [open]);

  return (
    <Drawer
      open={open}
      title={selected === null ? <Trans>后台任务</Trans> : <Trans>后台任务详情</Trans>}
      {...(selected === null ? { description: <Trans>分析 · 下载 · 录制 · 导出</Trans> } : {})}
      onClose={onClose}
    >
      {selected === null ? (
        <ActivityList
          items={items}
          total={feed.data?.total ?? 0}
          isLoading={feed.isPending}
          error={feed.isError ? dataErrorMessage(feed.error) ?? t`读取后台任务失败。` : null}
          onReload={() => void feed.refetch()}
          bind={bind}
          onSelect={setSelectedId}
        />
      ) : (
        <div className="flex min-h-0 flex-col gap-3">
          <Button variant="ghost" size="sm" onClick={() => setSelectedId(null)} className="self-start">
            <Trans>‹ 返回后台任务</Trans>
          </Button>
          <TaskDetailBody item={selected} service={service} compact />
        </div>
      )}
    </Drawer>
  );
}

interface ActivityListProps {
  readonly items: readonly ActivityItem[];
  readonly total: number;
  readonly isLoading: boolean;
  readonly error: string | null;
  readonly onReload: () => void;
  readonly bind: ReturnType<typeof useTaskActions>;
  readonly onSelect: (id: string) => void;
}

function ActivityList({ items, total, isLoading, error, onReload, bind, onSelect }: ActivityListProps) {
  if (error !== null) {
    return <Alert variant="danger" action={{ label: <Trans>重新加载</Trans>, onAction: onReload }}>{error}</Alert>;
  }
  if (isLoading) {
    return <div className="flex flex-col gap-5">{[0, 1, 2, 3].map((index) => <TaskCardSkeleton key={index} />)}</div>;
  }
  if (items.length === 0) {
    return <Empty title={<Trans>还没有后台任务</Trans>} description={<Trans>分析、下载、录制或导出开始后会出现在这里。</Trans>} actions={null} />;
  }

  return (
    <div className="flex flex-col gap-5">
      {GROUPS.map((group) => {
        const grouped = items.filter(group.includes);
        if (grouped.length === 0) return null;
        return (
          <section key={group.id} aria-labelledby={`activity-group-${group.id}`} className="flex flex-col border border-divider">
            <h3 id={`activity-group-${group.id}`} className="border-b border-divider px-3 py-2 font-heading text-sm">
              {group.label} · {grouped.length}
            </h3>
            <ul className="m-0 list-none p-0">
              {grouped.map((item) => {
                const bound = bind(item);
                return (
                  <li key={item.id} className="border-b border-divider p-3 last:border-b-0">
                    <TaskCard task={bound.summary} links={bound.links.filter((link) => link.id !== 'detail')} {...(bound.onCancel === undefined ? {} : { onCancel: bound.onCancel })} />
                    <div className="mt-2 flex justify-end">
                      <Button variant="ghost" size="sm" onClick={() => onSelect(item.id)}>
                        <Trans>查看详情</Trans>
                      </Button>
                    </div>
                  </li>
                );
              })}
            </ul>
          </section>
        );
      })}
      <p className="text-xs text-neutral-600">
        <Trans>共 {total} 条 · 第 1–{items.length} 条</Trans>
      </p>
    </div>
  );
}
