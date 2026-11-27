/** Show the most recent failed task as a compact status strip linking to /tasks. */

import { t } from '@lingui/core/macro';
import { Trans } from '@lingui/react/macro';
import { ArrowRight, CircleAlert } from 'lucide-react';
import type { ReactNode } from 'react';

import { Button } from '../../../design/primitives';
import { useTaskFeed } from '../../../data/tasks';
import { formatTaskClock, taskFailureLabels, taskKindLabels } from '../../../domain/task';
import { RouteLink } from '../../shared/navigation/RouteLink';
import { taskCenterPath, taskDetailPath, useTaskActions } from '../../../domain/task/useTaskActions';

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

  const kindLabel = taskKindLabels()[bound.summary.kind];
  const failureLabel = taskFailureLabels()[bound.summary.failure.reason];
  const internalCaptureFailure = isInternalCaptureFailure(bound.summary.failure.detail);
  const detail = internalCaptureFailure
    ? <Trans>采集组件没能启动。打开任务详情查看原因。</Trans>
    : bound.summary.failure.detail ?? failureLabel;
  const failed = feed.data?.summary.failed ?? 0;
  const recovery = bound.summary.failure.recovery;
  const stamp = formatTaskClock(bound.summary.startedAt, now === undefined ? {} : { now });

  return (
    <section
      aria-label={t`失败可恢复`}
      className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-md border border-fail-border bg-fail-surface/75 px-3.5 py-2.5 text-sm"
    >
      <CircleAlert className="size-4 flex-none text-fail-text" strokeWidth={1.75} aria-hidden="true" />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
          <span className="truncate font-medium text-text">
            {kindLabel} · {bound.summary.subject}
          </span>
          <span className="text-xs tabular-nums text-neutral-600">{stamp}</span>
          {failed > 1 ? (
            <span className="text-xs tabular-nums text-fail-text">
              <Trans>另有 {failed - 1} 条失败记录</Trans>
            </span>
          ) : null}
        </div>
        <p className="truncate text-xs text-fail-text">{detail}</p>
      </div>
      <div className="ml-auto flex flex-none flex-wrap items-center gap-1.5">
        {bound.restart !== undefined ? (
          <Button
            size="sm"
            variant="secondary"
            disabled={recovery.disabled}
            onClick={recovery.onAction}
          >
            {recovery.label}
          </Button>
        ) : (
          <Button asChild size="sm" variant="secondary">
            <RouteLink to={taskDetailPath(item)} className="no-underline">
              <Trans>查看详情</Trans>
            </RouteLink>
          </Button>
        )}
        <Button asChild size="sm" variant="ghost">
          <RouteLink to={taskCenterPath({ state: 'failed' })} className="no-underline">
            <Trans>任务中心</Trans>
            <ArrowRight className="size-3.5" aria-hidden="true" />
          </RouteLink>
        </Button>
      </div>
    </section>
  );
}

function isInternalCaptureFailure(detail: ReactNode | undefined): boolean {
  return typeof detail === 'string'
    && /(?:internal operation failed|managed HLAE|HLAE_[A-Z_]+)/iu.test(detail);
}
