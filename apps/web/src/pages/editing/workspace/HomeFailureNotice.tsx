/** Show the most recent failed task and link to the remaining failure records. */

import { t } from '@lingui/core/macro';
import { Trans } from '@lingui/react/macro';
import type { ReactNode } from 'react';

import { useTaskFeed } from '../../../data/tasks';
import { TaskCard } from '../../../domain/task';
import { RouteLink } from '../../shared/navigation/RouteLink';
import { useTaskActions } from '../../../domain/task/useTaskActions';

export interface HomeFailureNoticeProps {
  readonly now?: Date | undefined;
}

export function HomeFailureNotice({ now }: HomeFailureNoticeProps = {}) {
  const feed = useTaskFeed({ state: 'failed', page: 1, page_size: 1 });
  const bind = useTaskActions(now === undefined ? {} : { now });

  /* The service contract filters this feed, but keeping the status guard here
     prevents a permissive mock or a stale cache page from putting a running
     task (and its progress bar) back onto the workbench. */
  const item = feed.data?.items.find((candidate) => candidate.status === 'failed');
  if (item === undefined) return null;

  const bound = bind(item);
  if (bound.summary.status !== 'failed') return null;
  const internalCaptureFailure = isInternalCaptureFailure(bound.summary.failure.detail);
  const summary = {
    ...bound.summary,
    failure: {
      ...bound.summary.failure,
      // Keep capture diagnostics on the task detail page.
      detail: internalCaptureFailure
        ? <Trans>采集组件没能启动。打开任务详情查看原因。</Trans>
        : bound.summary.failure.detail,
      impact: internalCaptureFailure ? undefined : bound.summary.failure.impact,
    },
  };
  const failed = feed.data?.summary.failed ?? 0;

  return (
    <section aria-label={t`失败可恢复`} className="flex flex-col gap-3 border-t border-divider pt-5">
      <TaskCard task={summary} links={bound.links} headingLevel={2} showId={false} compact {...(now === undefined ? {} : { now })} />
      {failed > 1 ? (
        <p className="text-xs text-neutral-700">
          <RouteLink to="/tasks" size="sm">
            <Trans>另有 {failed - 1} 条失败记录</Trans>
          </RouteLink>
        </p>
      ) : null}
    </section>
  );
}

function isInternalCaptureFailure(detail: ReactNode | undefined): boolean {
  return typeof detail === 'string'
    && /(?:internal operation failed|managed HLAE|HLAE_[A-Z_]+)/iu.test(detail);
}
