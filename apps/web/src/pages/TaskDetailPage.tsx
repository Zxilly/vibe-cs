/*
 * pages/ — 任务详情与阶段日志 (spec §7 `/delivery/task/:taskId`, phase 3a).
 *
 * Navigation back to the finished file already lives in the shell breadcrumb.
 * The retired `?view=tasks` query normalizes to `/delivery`, so repeating a
 * second inline back link here would be both redundant and misleading.
 *
 * ── `:taskId` is `kind:jobId` ─────────────────────────────────────────────
 *
 * `commands.getActivity(kind, id)` needs both halves and refuses an answer
 * whose own id is not `kind:id`, so the route segment carries the service's
 * locator whole (percent-encoded — the colon is the separator). Parsing it back
 * is `delivery/taskDetailModel.ts`, and an address that names no real kind is
 * answered here rather than sent to the service.
 *
 * ── 重试 / 取消 go through `taskMachine` ───────────────────────────────────
 *
 * §4.3 makes one machine the task lifecycle, so both buttons are drawn from
 * `snapshot.can(event)` (`delivery/taskTransitions.ts`) and never from a status
 * comparison written on this page. A recording's 重试 starts nothing: it asks
 * for a plan and hands the user to `/recording`, because §4.5.3 ① says a
 * recording starts from one explicit confirmation.
 *
 * ── The three states ──────────────────────────────────────────────────────
 *
 * 加载中 / 空 / 失败 are the artboard's, in the artboard's components: a
 * `Skeleton`-backed placeholder while the record is on its way, an `Empty`
 * for an address that resolves to nothing, and — for a failed read — the error
 * preset with 重新加载 rather than a toast (§4.1: 「错误就地渲染成 Notice」).
 */

import { t } from '@lingui/core/macro';
import { Trans } from '@lingui/react/macro';
import { useParams } from 'react-router-dom';

import { dataErrorMessage } from '../data/errors';
import { useTask } from '../data/tasks';
import { Empty, Skeleton } from '../design/data';
import { Page, Toolbar } from '../design/layout';
import { Button } from '../design/primitives';
import { parseTaskLocator } from './delivery/taskDetailModel';
import { TaskDetailBody } from './delivery/TaskDetailBody';
import { TASK_POLL_DETAIL_MS } from './delivery/taskPolling';
import { useServiceAction } from '../data/serviceAction';
import { RouteLink } from './RouteLink';

export function TaskDetailPage() {
  const { taskId = '' } = useParams<{ taskId: string }>();
  const locator = parseTaskLocator(taskId);
  const service = useServiceAction();

  const task = useTask(locator?.kind ?? null, locator?.jobId ?? null, {
    pollWhileActiveMs: TASK_POLL_DETAIL_MS,
  });

  return (
    <Page
      scroll={false}
      toolbar={
        <Toolbar
          title={<Trans>后台任务详情</Trans>}
          meta={taskId}
        />
      }
    >
      {locator === null ? (
        <div className="p-7">
          <Empty
            variant="error"
            title={<Trans>找不到这条任务</Trans>}
            description={<Trans>这个地址不是一条后台任务的编号。后台任务里的每一条都能从列表打开。</Trans>}
            actions={
              <RouteLink to="/delivery">
                <Trans>回到成品文件</Trans>
              </RouteLink>
            }
            headingLevel={2}
          />
        </div>
      ) : task.isError ? (
        <div className="p-7">
          <Empty
            preset="error"
            title={<Trans>这条任务没能打开</Trans>}
            description={dataErrorMessage(task.error) ?? t`服务没有返回这条后台任务。`}
            actions={
              <Button variant="secondary" size="sm" onClick={() => void task.refetch()}>
                <Trans>重新加载</Trans>
              </Button>
            }
            headingLevel={2}
          />
        </div>
      ) : task.data === undefined ? (
        <div
          role="status"
          aria-busy="true"
          aria-label={t`正在读取任务详情`}
          className="flex flex-col gap-3 p-7"
        >
          <Skeleton width="38%" className="h-4" />
          <Skeleton width="62%" />
          <Skeleton />
          <Skeleton width="86%" />
        </div>
      ) : (
        <TaskDetailBody item={task.data} service={service} />
      )}
    </Page>
  );
}
