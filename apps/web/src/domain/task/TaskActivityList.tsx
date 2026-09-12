import { Trans } from '@lingui/react/macro';

import { Empty } from '../../design/data';
import { Alert } from '../../design/feedback';
import { Button } from '../../design/primitives';
import type { ActivityItem } from '../../shared/desktop/viewModels';
import { TaskCard } from './TaskCard';
import { TaskCardSkeleton } from './TaskCard';
import type { useTaskActions } from './useTaskActions';

const GROUPS = [
  { id: 'active', label: <Trans>进行中</Trans>, includes: (item: ActivityItem) => !['completed', 'failed', 'cancelled'].includes(item.status) },
  { id: 'failed', label: <Trans>失败</Trans>, includes: (item: ActivityItem) => item.status === 'failed' },
  { id: 'completed', label: <Trans>已完成</Trans>, includes: (item: ActivityItem) => item.status === 'completed' },
  { id: 'cancelled', label: <Trans>已取消</Trans>, includes: (item: ActivityItem) => item.status === 'cancelled' },
] as const;

interface TaskActivityListProps {
  readonly items: readonly ActivityItem[];
  readonly total: number;
  readonly firstItem?: number;
  readonly selectedId?: string | null;
  readonly isLoading: boolean;
  readonly error: string | null;
  readonly onReload: () => void;
  readonly bind: ReturnType<typeof useTaskActions>;
  readonly onSelect: (id: string) => void;
}

export function TaskActivityList({ items, total, firstItem = 1, selectedId, isLoading, error, onReload, bind, onSelect }: TaskActivityListProps) {
  if (error !== null) {
    return <Alert variant="danger" action={{ label: <Trans>重新加载</Trans>, onAction: onReload }}>{error}</Alert>;
  }
  if (isLoading) {
    return <div className="flex flex-col gap-5">{[0, 1, 2, 3].map((index) => <TaskCardSkeleton key={index} />)}</div>;
  }
  if (items.length === 0) {
    return <Empty title={<Trans>还没有后台任务</Trans>} actions={null} />;
  }

  return (
    <div className="flex min-w-0 flex-col gap-4 overflow-x-hidden">
      {GROUPS.map((group) => {
        const grouped = items.filter(group.includes);
        if (grouped.length === 0) return null;
        return (
          <section key={group.id} aria-labelledby={`activity-group-${group.id}`} className="flex flex-col border border-divider">
            <h3 id={`activity-group-${group.id}`} className="border-b border-divider px-3 py-2 font-heading text-sm">
              {group.label} · {grouped.length}
            </h3>
            <ul className="m-0 list-none p-0">
              {grouped.map((item, index) => {
                const bound = bind(item);
                const focused = selectedId === undefined ? group.id === 'failed' && index === 0 : selectedId === item.id;
                return (
                  <li
                    key={item.id}
                    data-activity-focused={focused ? 'true' : undefined}
                    className={focused
                      ? 'border-b border-divider bg-accent-100 p-3 shadow-[inset_2px_0_0_var(--color-fail)] last:border-b-0'
                      : 'border-b border-divider p-3 last:border-b-0'}
                  >
                    <TaskCard
                      task={bound.summary}
                      compact
                      showId={false}
                      links={bound.links.filter((link) => link.id !== 'detail')}
                      {...(bound.onCancel === undefined ? {} : { onCancel: bound.onCancel })}
                    />
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
        <Trans>共 {total} 条 · 第 {firstItem}–{firstItem + items.length - 1} 条</Trans>
      </p>
    </div>
  );
}
