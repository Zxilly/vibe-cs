/*
 * pages/recording — the bare `/recording`: what can be recorded, and what has
 * been.
 *
 * Two columns, because the address answers two questions that have different
 * objects behind them:
 *
 *   可录制的方案     `listAgentPlans` — an Agent plan is the thing this page
 *                    turns into a recording, so each row opens
 *                    `/recording/<planId>`, which is the artboard.
 *   最近的录制任务    the activity feed filtered to `kind: 'recording'`. A task
 *                    row links to `/delivery/task/:id` and **does not open
 *                    here** — a running recording already has a first-class
 *                    address with the stage log on it (§7), and a second task
 *                    detail on this page would be two screens for one object.
 *
 * The task column is `pages/delivery`'s own `TaskFeedList` bound with
 * `useTaskActions`, not a second list: 取消 and 重试 mean the same thing on this
 * page as on 任务记录, and one binding is how that stays true.
 *
 * ── The one thing the plan list cannot say ────────────────────────────────
 *
 * `AgentPlanSummary` carries `shot_count` but nothing about whether those shots
 * have a `recording` binding, and there is no `?recordable=` filter on
 * `GET /api/agent/plans`. So this column lists every plan with at least one
 * shot and each row is honest about what it knows — the count, the revision and
 * the status. Whether a plan can actually be recorded is answered by opening it,
 * where the 422 arrives with the shots it is about. Reported as a gap; a
 * `recordable_shot_count` on the summary would let this column filter instead of
 * promising.
 */

import { t } from '@lingui/core/macro';
import { useLingui } from '@lingui/react';
import { Trans } from '@lingui/react/macro';
import { useNavigate } from 'react-router-dom';

import { dataErrorMessage } from '../../data/errors';
import { useAgentPlanList } from '../../data/plans';
import { useServiceAction } from '../../data/serviceAction';
import { useTaskFeed } from '../../data/tasks';
import { EmptyState, Skeleton } from '../../design/data';
import { Notice } from '../../design/feedback';
import { Button, Tag } from '../../design/primitives';
import { AGENT_PLAN_STATUS } from '../../domain/agent';
import type { AgentPlanSummary } from '../../shared/desktop/dto';
import { TaskFeedList } from '../delivery/TaskFeedList';
import { useTaskActions } from '../delivery/useTaskActions';
import { RouteLink } from '../RouteLink';
import { recordingHref } from './recordingContract';

/** How many recent recording tasks the right column shows. The feed is paged
 *  and the whole record lives on `/delivery`; this is a digest, so it prints
 *  the total beside it rather than pretending to be the list. */
const RECENT_TASK_LIMIT = 8;

export function RecordingIndex() {
  const service = useServiceAction();
  const navigate = useNavigate();

  const plans = useAgentPlanList({ limit: 20 });
  const tasks = useTaskFeed({ kind: 'recording', page_size: RECENT_TASK_LIMIT });
  const bind = useTaskActions({ service });

  const planFailure = dataErrorMessage(plans.error);
  const taskFailure = dataErrorMessage(tasks.error);
  const planRows = (plans.data ?? []).filter((plan) => plan.shot_count > 0);
  const taskRows = tasks.data?.items ?? [];

  /* Both empty is one empty state, not two: the page has nothing to show and
     the way out is the same door in both halves. */
  if (
    !plans.isPending
    && !tasks.isPending
    && planFailure === null
    && taskFailure === null
    && planRows.length === 0
    && taskRows.length === 0
  ) {
    return (
      <EmptyState
        className="m-7"
        title={<Trans>还没有可以录制的方案</Trans>}
        description={
          <Trans>先在 Agent 里做一份镜头方案，绑定好 Demo 与选手之后，这里会列出可以录制的方案。</Trans>
        }
        actions={
          <Button variant="primary" onClick={() => void navigate('/agent')}>
            <Trans>去做一份方案</Trans>
          </Button>
        }
      />
    );
  }

  return (
    <div className="flex min-h-0 min-w-0 flex-1" data-recording-index="true">
      <section
        aria-label={t`可录制的方案`}
        className="flex min-h-0 min-w-0 flex-1 flex-col border-r border-divider"
      >
        <header className="flex h-[var(--h-panel-head)] flex-none items-center gap-2 border-b border-divider px-5">
          <h2 className="font-heading text-sm tracking-caps">
            <Trans>可录制的方案</Trans>
          </h2>
          {plans.data === undefined ? null : (
            <span className="text-xs text-neutral-600">
              <Trans>共 {plans.data.length} 份</Trans>
            </span>
          )}
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto">
          <PlanColumn
            rows={planRows}
            isPending={plans.isPending}
            failure={planFailure}
            onReload={() => void plans.refetch()}
            onNewPlan={() => void navigate('/agent')}
          />
        </div>
      </section>

      <section
        aria-label={t`最近的录制任务`}
        className="flex w-[var(--w-split)] min-h-0 flex-none flex-col"
      >
        <header className="flex h-[var(--h-panel-head)] flex-none items-center gap-2 border-b border-divider px-5">
          <h2 className="font-heading text-sm tracking-caps">
            <Trans>最近的录制任务</Trans>
          </h2>
          {tasks.data === undefined ? null : (
            <span className="text-xs text-neutral-600">
              <Trans>共 {tasks.data.total} 条</Trans>
            </span>
          )}
          <div className="flex-1" aria-hidden="true" />
          <RouteLink to="/delivery?view=tasks" size="xs">
            <Trans>全部任务记录</Trans>
          </RouteLink>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto">
          <TaskFeedList
            items={taskRows}
            bind={bind}
            isLoading={tasks.isPending}
            {...(taskFailure === null ? {} : { errorMessage: taskFailure })}
            onReload={() => void tasks.refetch()}
            emptyTitle={<Trans>还没有录制任务</Trans>}
            emptyDescription={<Trans>开始一次录制之后，过程与失败原因都会记在这里。</Trans>}
            emptyActions={
              <RouteLink to="/delivery?view=tasks">
                <Trans>打开任务记录</Trans>
              </RouteLink>
            }
          />
        </div>
      </section>
    </div>
  );
}

/* ── the plan column ─────────────────────────────────────────────────────── */

function PlanColumn({
  rows,
  isPending,
  failure,
  onReload,
  onNewPlan,
}: {
  readonly rows: readonly AgentPlanSummary[];
  readonly isPending: boolean;
  readonly failure: string | null;
  readonly onReload: () => void;
  readonly onNewPlan: () => void;
}) {
  const { i18n } = useLingui();

  if (failure !== null) {
    return (
      <div className="p-5">
        <Notice tone="danger" action={{ label: <Trans>重新加载</Trans>, onAction: onReload }}>
          <Trans>读不到方案列表：{failure}</Trans>
        </Notice>
      </div>
    );
  }

  if (isPending) {
    return (
      <ul className="list-none" data-plan-list="loading">
        {Array.from({ length: 5 }, (_unused, index) => (
          <li key={index} className="border-b border-divider px-5 py-4">
            <Skeleton width="60%" />
          </li>
        ))}
      </ul>
    );
  }

  if (rows.length === 0) {
    return (
      <EmptyState
        className="m-5"
        title={<Trans>还没有可以录制的方案</Trans>}
        description={<Trans>方案里至少要有一个镜头，才能生成录制计划。</Trans>}
        actions={
          <Button variant="secondary" onClick={onNewPlan}>
            <Trans>打开 Agent</Trans>
          </Button>
        }
      />
    );
  }

  return (
    <ul className="list-none" data-plan-list="ready">
      {rows.map((plan) => (
        <li key={plan.id} data-plan={plan.id} className="border-b border-divider px-5 py-4">
          <div className="flex items-baseline gap-3">
            <RouteLink to={recordingHref(plan.id)} size="base">
              {plan.title}
            </RouteLink>
            <Tag tone="neutral">{i18n._(AGENT_PLAN_STATUS[plan.status].label)}</Tag>
          </div>
          <p className="mt-1 text-xs text-neutral-600">
            <Trans>
              {plan.shot_count} 个镜头 · 修订 {plan.revision}
            </Trans>
          </p>
        </li>
      ))}
    </ul>
  );
}
