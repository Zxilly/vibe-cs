/*
 * pages/ — 任务详情与阶段日志 (spec §7 `/delivery/task/:taskId`, phase 3a).
 *
 * The back link goes to `/delivery?view=tasks` rather than `/delivery`: the
 * task list is where this page was opened from, and dropping the query would
 * land the user on 输出 instead.
 */

import { Trans } from '@lingui/react/macro';
import { useParams } from 'react-router-dom';

import { Page, Toolbar } from '../design/layout';
import { PagePlaceholder } from './PagePlaceholder';
import { RouteLink } from './RouteLink';

export function TaskDetailPage() {
  const { taskId = '' } = useParams<{ taskId: string }>();

  return (
    <Page
      toolbar={
        <Toolbar
          leading={
            <RouteLink to="/delivery?view=tasks">
              <Trans>‹ 任务记录</Trans>
            </RouteLink>
          }
          title={<Trans>任务详情</Trans>}
          meta={taskId}
        />
      }
    >
      <PagePlaceholder
        phase="3a"
        description={
          <Trans>详情页给出这条任务的阶段进度与日志：启动、跳转、采集、稳定、编码、发布。</Trans>
        }
      />
    </Page>
  );
}
