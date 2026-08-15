/*
 * pages/home — 「进行中」, the panel 「01 工作台首页」 draws under the header.
 *
 * The artboard: a 40px panel head (进行中 · a count · 全部任务 on the right) and
 * two 64px rows, each a marker, a title, a stage line, a bar and 取消 / 停止.
 * That row *is* `domain/task/TaskCard` — its own header says so ("the 任务记录
 * entries of 「11 输出与任务记录」 and the 64px task rows of 「01 工作台首页」"),
 * so this panel is the frame plus the query and nothing else.
 *
 * ── The bar only appears where there is a denominator ─────────────────────
 *
 * The artboard draws 62% and 2/6 on these two rows, and both come from the
 * service (`completed_units` / `total_units`, or `progress_percent`). Where it
 * sent neither, the card falls through to the stage name — see `taskModel.tsx`.
 * Nothing on this page turns a stage index into a percentage.
 *
 * ── Polling ───────────────────────────────────────────────────────────────
 *
 * 10 s, and nothing at all once the last task stops (`taskPolling.ts`). The
 * workbench is a landing surface; the pages it links to are where a task is
 * actually watched.
 */

import { t } from '@lingui/core/macro';
import { Trans } from '@lingui/react/macro';

import { dataErrorMessage } from '../../data/errors';
import { useTaskFeed } from '../../data/tasks';
import { Toolbar } from '../../design/layout';
import { TaskFeedList } from '../delivery/TaskFeedList';
import { TASK_POLL_DIGEST_MS } from '../delivery/taskPolling';
import { useTaskActions } from '../delivery/useTaskActions';
import type { ServiceActionState } from '../../data/serviceAction';
import { RouteLink } from '../RouteLink';

/**
 * `CONCURRENT_TASK_COUNT` in `domain/densityFixtures.ts` — the brief's stated
 * ceiling of simultaneous tasks. Asking for more than can run wastes rows; the
 * artboard draws two and the panel is happy with five.
 */
const RUNNING_TASK_LIMIT = 5;

export interface HomeTasksPanelProps {
  readonly service: ServiceActionState;
  readonly now?: Date | undefined;
}

export function HomeTasksPanel({ service, now }: HomeTasksPanelProps) {
  const feed = useTaskFeed(
    { state: 'active', page: 1, page_size: RUNNING_TASK_LIMIT },
    { pollWhileActiveMs: TASK_POLL_DIGEST_MS },
  );
  const bind = useTaskActions({ service, ...(now === undefined ? {} : { now }) });

  const errorMessage = feed.isError
    ? dataErrorMessage(feed.error) ?? t`读取进行中的任务失败。`
    : undefined;

  return (
    <section aria-label={t`进行中的任务`} className="flex flex-col border border-divider">
      <Toolbar
        height="panel"
        title={<Trans>进行中</Trans>}
        meta={feed.data === undefined ? undefined : String(feed.data.summary.active)}
        primary={
          <RouteLink to="/delivery?view=tasks" size="sm">
            <Trans>全部任务</Trans>
          </RouteLink>
        }
      />

      <TaskFeedList
        items={feed.data?.items ?? []}
        bind={bind}
        isLoading={feed.isPending}
        {...(errorMessage === undefined ? {} : { errorMessage })}
        onReload={() => void feed.refetch()}
        emptyTitle={<Trans>现在没有任务在跑</Trans>}
        emptyDescription={<Trans>分析、录制与导出开始后会出现在这里，可以从这里直接停止。</Trans>}
        emptyActions={
          <RouteLink to="/library">
            <Trans>去资料库开始一次分析</Trans>
          </RouteLink>
        }
        skeletonRows={2}
        headingLevel={4}
        {...(now === undefined ? {} : { now })}
      />
    </section>
  );
}
