/*
 * pages/home — 「失败可恢复」, the brick-red block on 「01 工作台首页」.
 *
 * The artboard draws one failed task between 进行中 and 最近比赛:
 * 「导出未完成：磁盘空间不足，已保留工程与素材 · 影响范围：仅这一次导出 · 释放
 * 4.2 GB 后可继续」 with 打开输出目录 and 重试导出.
 *
 * It is drawn by `TaskCard`, not by a hand-written `Notice`: a failed
 * `TaskSummary` renders its own danger Notice with the required recovery
 * action, so this component is the query plus the decision to show at most one.
 * At most one, because the header already counts them (「1 个失败可恢复」) and a
 * landing page that lists every failure since install is a task record, which
 * is one link away.
 *
 * Renders nothing when there is nothing to recover from — 「环境问题只在阻塞
 * 相应任务时出现在这里」 is the same rule applied to failures: an absent block
 * is the good state, and an empty state for it would be noise.
 */

import { t } from '@lingui/core/macro';
import { Trans } from '@lingui/react/macro';
import type { ReactNode } from 'react';

import { useTaskFeed } from '../../data/tasks';
import { TaskCard } from '../../domain/task';
import { RouteLink } from '../RouteLink';
import { useTaskActions } from '../delivery/useTaskActions';
import type { ServiceActionState } from '../../data/serviceAction';

export interface HomeFailureNoticeProps {
  readonly service: ServiceActionState;
  readonly now?: Date | undefined;
}

export function HomeFailureNotice({ service, now }: HomeFailureNoticeProps) {
  /*
   * No polling. A failure does not un-fail, and a *new* one can only appear
   * when a running task ends — which the 进行中 panel above is already polling
   * for, and whose mutations invalidate `qk.tasks.all` for both panels.
   */
  const feed = useTaskFeed({ state: 'failed', page: 1, page_size: 1 });
  const bind = useTaskActions({ service, ...(now === undefined ? {} : { now }) });

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
      // The workbench is a digest. The classified reason stays here; the raw
      // service sentence and impact belong on 查看阶段 / 后台任务详情.
      detail: internalCaptureFailure
        ? <Trans>受管 HLAE 采集未能开始，打开任务详情查看原因。</Trans>
        : bound.summary.failure.detail,
      impact: internalCaptureFailure ? undefined : bound.summary.failure.impact,
    },
  };
  const failed = feed.data?.summary.failed ?? 0;

  return (
    <section aria-label={t`失败可恢复`} className="flex flex-col gap-3 border border-fail-border p-5">
      <TaskCard task={summary} links={bound.links} headingLevel={3} showId={false} {...(now === undefined ? {} : { now })} />
      {failed > 1 ? (
        <p className="text-xs text-neutral-700">
          <RouteLink to="/delivery?view=tasks" size="sm">
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
