/*
 * pages/delivery — a column of task records with its three states.
 *
 * Used three times over: the 任务记录 view, the 520px rail beside 输出, and the
 * workbench's 进行中 digest. Each of those passes a different slice of the same
 * feed; none of them re-implements 加载中 / 空 / 失败.
 *
 * The three states are the artboard's, drawn by the design layer rather than by
 * hand (「补齐 · 规范与状态 · 空 · 加载 · 错误」):
 *
 *   loading  `TaskCardSkeleton` — bars, no invented percentage
 *   empty    `EmptyState`, with the caller's own copy, because 「还没有任务记录」
 *            and 「没有进行中的任务」 are different sentences about different
 *            filters
 *   error    `Notice` in place, with one recovery action (重新加载). §4.1:
 *            「错误就地渲染成 Notice」, never a toast.
 *
 * The list itself is a `<ul>` with hairline separators, matching the rail on
 * 「11 输出与任务记录」 where each record is separated by the marker's own
 * vertical rule.
 */

import { Trans } from '@lingui/react/macro';
import type { ReactNode } from 'react';

import { EmptyState } from '../../design/data';
import { Notice } from '../../design/feedback';
import { Button, cx } from '../../design/primitives';
import { TaskCard, TaskCardSkeleton } from '../../domain/task';
import type { ActivityItem } from '../../shared/desktop/dto';
import type { TaskCardBindings } from './useTaskActions';

export interface TaskFeedListProps {
  readonly items: readonly ActivityItem[];
  readonly bind: (item: ActivityItem) => TaskCardBindings;
  readonly isLoading: boolean;
  /** The read's error, already turned into a sentence by `dataErrorMessage`. */
  readonly errorMessage?: string | undefined;
  readonly onReload: () => void;
  readonly emptyTitle: ReactNode;
  readonly emptyDescription: ReactNode;
  /** The empty state's required recovery action. */
  readonly emptyActions: ReactNode;
  readonly skeletonRows?: number | undefined;
  readonly headingLevel?: 3 | 4 | undefined;
  readonly now?: Date | undefined;
  readonly className?: string | undefined;
}

export function TaskFeedList({
  items,
  bind,
  isLoading,
  errorMessage,
  onReload,
  emptyTitle,
  emptyDescription,
  emptyActions,
  skeletonRows = 4,
  headingLevel = 3,
  now,
  className,
}: TaskFeedListProps) {
  if (errorMessage !== undefined) {
    return (
      <div className={cx('p-5', className)}>
        <Notice tone="danger" action={{ label: <Trans>重新加载</Trans>, onAction: onReload }}>
          {errorMessage}
        </Notice>
      </div>
    );
  }

  if (isLoading) {
    return (
      <div className={cx('flex flex-col gap-5 p-5', className)}>
        {Array.from({ length: skeletonRows }, (_unused, index) => (
          // Positional placeholders: they stand for rows that have no identity
          // yet, so the index is the only key there can be.
          <TaskCardSkeleton key={index} />
        ))}
      </div>
    );
  }

  if (items.length === 0) {
    return (
      <div className={cx('p-5', className)}>
        <EmptyState
          title={emptyTitle}
          description={emptyDescription}
          actions={emptyActions}
          headingLevel={headingLevel}
        />
      </div>
    );
  }

  return (
    <ul data-task-feed className={cx('m-0 flex list-none flex-col p-0', className)}>
      {items.map((item) => {
        const bound = bind(item);
        return (
          <li
            key={item.id}
            className="border-b border-divider px-5 py-4 last:border-b-0"
          >
            <TaskCard
              task={bound.summary}
              links={bound.links}
              headingLevel={headingLevel}
              {...(bound.onCancel === undefined ? {} : { onCancel: bound.onCancel })}
              {...(now === undefined ? {} : { now })}
            />
            {/* 「重新发起」 is a restart of a cancelled task; a failed task's
                retry already lives inside the card's failure Notice, which is
                where 「每条都带一个主要恢复动作」 puts it. Drawing a second
                button for the failed case would be the same action twice. */}
            {bound.restart !== undefined && bound.summary.status === 'cancelled' ? (
              <div className="mt-2 flex justify-end">
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={bound.restart.run}
                  disabled={bound.restart.disabled}
                  {...(bound.restart.disabledReason === undefined
                    ? {}
                    : { disabledReason: bound.restart.disabledReason })}
                >
                  <Trans>重新发起</Trans>
                </Button>
              </div>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}
