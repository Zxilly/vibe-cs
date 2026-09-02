/*
 * pages/delivery — 交付 › 任务记录, the `?view=tasks` face of §7's `/delivery`.
 *
 * 「11 输出与任务记录」 draws the task record as a 520px rail beside the outputs.
 * That rail is a digest — four entries and two footer buttons. `?view=tasks` is
 * the same records with the whole width: the filter strip the outputs column
 * has, the full page of records, and a pager that prints the total.
 *
 * ── 最近 50 条 ────────────────────────────────────────────────────────────
 *
 * `page_size` is 50 because that is the retention default the product ships
 * (「12 设置与诊断 · 保留多久」 has 「最近 50 条」 checked, and
 * `domain/densityFixtures.ts` records it as `TASK_RECORD_COUNT`). §10.3's
 * density rule then applies: 「该分页的要分页且页脚印出总数（静默截断是 bug）」,
 * so the footer is a real `Pagination` over `feed.total` rather than a list that
 * quietly stops at fifty.
 *
 * ── Filter state is component state, not a query parameter ────────────────
 *
 * §7 defines exactly one parameter for this route (`view`). The state filter
 * and the page number are not in that contract, so they are not written into
 * the address bar — a deep link that survives a redesign of this page is worth
 * more than a shareable filter nobody asked for. Both are one `useState` away
 * from being promoted if the product wants them.
 */

import { t } from '@lingui/core/macro';
import { Trans } from '@lingui/react/macro';
import { useState } from 'react';

import { Pagination } from '../../design/data';
import { Toolbar } from '../../design/layout';
import { Seg } from '../../design/primitives';
import { dataErrorMessage } from '../../data/errors';
import { useTaskFeed } from '../../data/tasks';
import type { ActivityQuery } from '../../shared/desktop/dto';
import { RouteLink } from '../RouteLink';
import { TaskFeedList } from './TaskFeedList';
import { TASK_POLL_FEED_MS } from './taskPolling';
import { useTaskActions } from './useTaskActions';

/** 「最近 50 条」 — see the module note. */
export const TASK_RECORD_PAGE_SIZE = 50;

/** The four states `ActivityQuery.state` accepts, plus 全部 (no filter). */
const TASK_STATE_FILTERS = ['all', 'active', 'failed', 'completed', 'cancelled'] as const;
type TaskStateFilter = (typeof TASK_STATE_FILTERS)[number];

function stateFilterLabels(): Readonly<Record<TaskStateFilter, string>> {
  return {
    all: t`全部`,
    active: t`进行中`,
    failed: t`失败`,
    completed: t`已完成`,
    cancelled: t`已取消`,
  };
}

export interface TaskRecordViewProps {
  readonly now?: Date | undefined;
}

export function TaskRecordView({ now }: TaskRecordViewProps) {
  const [state, setState] = useState<TaskStateFilter>('all');
  const [page, setPage] = useState(1);

  const query: ActivityQuery = {
    page,
    page_size: TASK_RECORD_PAGE_SIZE,
    ...(state === 'all' ? {} : { state }),
  };

  const feed = useTaskFeed(query, { pollWhileActiveMs: TASK_POLL_FEED_MS });
  const bind = useTaskActions(now === undefined ? {} : { now });

  const labels = stateFilterLabels();
  const items = feed.data?.items ?? [];
  const errorMessage = feed.isError
    ? dataErrorMessage(feed.error) ?? t`读取后台任务失败。`
    : undefined;

  return (
    <>
      <Toolbar
        height="bar"
        tone="chrome"
        title={<Trans>后台任务</Trans>}
        meta={
          feed.data === undefined ? undefined : (
            <Trans>
              进行中 {feed.data.summary.active} · 失败 {feed.data.summary.failed} · 已完成{' '}
              {feed.data.summary.completed}
            </Trans>
          )
        }
      >
        <Seg
          name="delivery-task-state"
          aria-label={t`按状态筛选任务`}
          size="sm"
          value={state}
          options={TASK_STATE_FILTERS.map((value) => ({ value, label: labels[value] }))}
          onChange={(value) => {
            setState(value);
            // A filter change re-pages from the front: staying on page 4 of a
            // list that now has one page shows an empty column and no reason.
            setPage(1);
          }}
        />
      </Toolbar>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <TaskFeedList
          items={items}
          bind={bind}
          isLoading={feed.isPending}
          {...(errorMessage === undefined ? {} : { errorMessage })}
          onReload={() => void feed.refetch()}
          emptyTitle={<Trans>还没有后台任务</Trans>}
          emptyDescription={
            <Trans>分析、下载、录制与导出都会在这里留下一条记录，包含阶段与失败原因。</Trans>
          }
          emptyActions={
            <RouteLink to="/library">
              <Trans>去资料库开始一次分析</Trans>
            </RouteLink>
          }
          skeletonRows={6}
          {...(now === undefined ? {} : { now })}
        />
      </div>

      <Pagination
        page={page}
        pageSize={TASK_RECORD_PAGE_SIZE}
        total={feed.data?.total ?? 0}
        onPageChange={setPage}
      />
    </>
  );
}
