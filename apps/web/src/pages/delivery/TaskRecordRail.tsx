/*
 * pages/delivery — the 520px 任务记录 rail that stands beside 输出.
 *
 * 「11 输出与任务记录」 draws both at once: the outputs take the remaining width
 * and the rail holds four task records with a two-button footer. The `?view=`
 * segmented control switches which of the two is *the page*; the rail is the
 * digest that keeps 「每个输出能回看来源任务」 true without a trip.
 *
 * It shows the four most recent records, which is what the artboard draws, and
 * links to the full view rather than paging: a digest that pages is a second
 * list, and there is already one.
 *
 * 导出诊断 JSON — the artboard's other footer button — is not here. No command
 * produces it (`shared/desktop/client.ts` has no diagnostics export), and the
 * 恢复中心 route beside it does exist, so only that one is drawn. Reported as a
 * gap rather than wired to something that would download nothing.
 */

import { t } from '@lingui/core/macro';
import { Trans } from '@lingui/react/macro';

import { dataErrorMessage } from '../../data/errors';
import { useTaskFeed } from '../../data/tasks';
import { Toolbar } from '../../design/layout';
import { RouteLink } from '../RouteLink';
import { TaskFeedList } from './TaskFeedList';
import { TASK_POLL_FEED_MS } from './taskPolling';
import { useTaskActions } from './useTaskActions';
import type { ServiceActionState } from '../../data/serviceAction';

/** What 「11 输出与任务记录」 draws in the rail. */
export const TASK_RAIL_COUNT = 4;

export interface TaskRecordRailProps {
  readonly service: ServiceActionState;
  readonly now?: Date | undefined;
}

export function TaskRecordRail({ service, now }: TaskRecordRailProps) {
  const feed = useTaskFeed(
    { page: 1, page_size: TASK_RAIL_COUNT },
    { pollWhileActiveMs: TASK_POLL_FEED_MS },
  );
  const bind = useTaskActions({ service, ...(now === undefined ? {} : { now }) });

  const errorMessage = feed.isError
    ? dataErrorMessage(feed.error) ?? t`读取任务记录失败。`
    : undefined;

  return (
    <>
      <Toolbar
        height="bar"
        title={<Trans>任务记录</Trans>}
        meta={<Trans>分析 · 下载 · 录制 · 导出</Trans>}
      />

      <div className="min-h-0 flex-1 overflow-y-auto">
        <TaskFeedList
          items={feed.data?.items ?? []}
          bind={bind}
          isLoading={feed.isPending}
          {...(errorMessage === undefined ? {} : { errorMessage })}
          onReload={() => void feed.refetch()}
          emptyTitle={<Trans>还没有任务记录</Trans>}
          emptyDescription={<Trans>分析、下载、录制与导出都会在这里留下一条记录。</Trans>}
          emptyActions={
            <RouteLink to="/library">
              <Trans>去资料库开始一次分析</Trans>
            </RouteLink>
          }
          skeletonRows={3}
          headingLevel={4}
          {...(now === undefined ? {} : { now })}
        />
      </div>

      <div className="flex flex-none items-center gap-3 border-t border-divider px-5 py-4">
        <RouteLink to="/delivery?view=tasks" size="sm">
          <Trans>全部任务记录</Trans>
        </RouteLink>
        <div className="flex-1" />
        <RouteLink to="/recovery" size="sm">
          <Trans>恢复中心</Trans>
        </RouteLink>
      </div>
    </>
  );
}
