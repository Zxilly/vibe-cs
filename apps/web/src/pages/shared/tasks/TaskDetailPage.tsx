/** Addressable task detail with loading, failure and recovery states. */

import { t } from '@lingui/core/macro';
import { Trans } from '@lingui/react/macro';
import { useParams } from 'react-router-dom';

import { dataErrorMessage } from '../../../data/errors';
import { useTask } from '../../../data/tasks';
import { Empty, Skeleton } from '../../../design/data';
import { Page, Toolbar } from '../../../design/layout';
import { Button } from '../../../design/primitives';
import { parseTaskLocator } from '../../../domain/task/taskDetailModel';
import { TaskDetailBody } from '../../../domain/task/TaskDetailBody';
import { TASK_POLL_DETAIL_MS } from '../../../domain/task/taskPolling';
import { RouteLink } from '../navigation/RouteLink';

export function TaskDetailPage() {
  const { taskId = '' } = useParams<{ taskId: string }>();
  const locator = parseTaskLocator(taskId);
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
        <div className="p-6">
          <Empty
            variant="error"
            title={<Trans>找不到这条任务</Trans>}
            description={<Trans>这个地址不是一条后台任务的编号。后台任务里的每一条都能从列表打开。</Trans>}
            actions={
              <RouteLink to="/tasks">
                <Trans>回到任务中心</Trans>
              </RouteLink>
            }
            headingLevel={2}
          />
        </div>
      ) : task.isError ? (
        <div className="p-6">
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
          className="flex flex-col gap-3 p-6"
        >
          <Skeleton width="38%" className="h-4" />
          <Skeleton width="62%" />
          <Skeleton />
          <Skeleton width="86%" />
        </div>
      ) : (
        <TaskDetailBody item={task.data} />
      )}
    </Page>
  );
}
