/*
 * pages/home — 待确认的方案, the block the artboard puts at the very top.
 *
 * 「从『功能入口集合』改为『今日需要处理的工作』：待确认方案在最上」 is the
 * board's own instruction for this page, and this is the block it is about. A
 * plan in `awaiting_confirmation` is work the Agent has finished and the user
 * has not looked at — the one thing on the workbench that is *waiting on them*.
 *
 * ── What the board draws that the wire does not carry ────────────────────
 *
 * The card on the board reads 「Kael · Mirage 第 21 回合 1v3 残局 · 4 个镜头 ·
 * 预计 42 秒」, then a sentence about the evidence behind it. `AgentPlanSummary`
 * is `{ id, title, status, revision, shot_count, origin_count, created_at,
 * updated_at }`:
 *
 *   ✓ 4 个镜头        `shot_count`
 *   ✓ 依据 3 条证据   `origin_count`
 *   ✓ 预计 42 秒      `total_duration_seconds`, added to the summary in the
 *                     gap-closing round. It is computed where the shot bodies
 *                     already are — the alternative was N more requests to
 *                     print one number per row.
 *   ✗ Kael · Mirage   no Demo or player binding on a plan at all (§10.5 gap 1)
 *
 * So the row prints the title, the length, the shot count and the evidence
 * count, and does **not** print a subject. Inventing the subject line is not
 * available at any price.
 *
 * Both counts exclude soft-removed shots, which is a property of the summary
 * rather than of this row: a plan the user has taken two shots out of reads
 * the same here as it does on the page this row opens.
 *
 * ── 「稍后处理」 ─────────────────────────────────────────────────────────
 *
 * 「今天不再提醒」, computed here as the next *local* midnight: a plan pushed
 * away at 23:50 is back ten minutes later, which is what the words say and is
 * why it is not 「24 小时」. The service stores the instant and cannot compute
 * it, because it does not know the reader's timezone.
 *
 * It is not `Archived`. Archiving is the permanent 「不做了」; a snoozed plan is
 * still awaiting confirmation and returns on its own. Nothing is hidden
 * forever, which is why there is no 「已忽略」 list to go find it in.
 *
 * The filter runs here rather than in the query: the服务 answers with the
 * plans and their `snoozed_until`, and a row whose instant has passed comes
 * back on the next read without anything having to clear a flag.
 */

import { t } from '@lingui/core/macro';
import { Plural, Trans } from '@lingui/react/macro';

import { Skeleton } from '../../design/data';
import { Alert } from '../../design/feedback';
import { Button } from '../../design/primitives';
import { nextLocalMidnight, useAgentPlanList, useSnoozeAgentPlan } from '../../data/plans';
import { dataErrorMessage } from '../../data/errors';
import type { AgentPlanSummary } from '../../shared/desktop/dto';
import { formatShotDuration } from '../../domain/agent';
import { RouteLink } from '../RouteLink';

/** Enough to show the queue without turning the workbench into a list page. */
const SHOWN = 3;

export function PendingPlansPanel() {
  const plans = useAgentPlanList({ status: 'awaiting_confirmation', limit: 10 });
  const snooze = useSnoozeAgentPlan();
  const error = dataErrorMessage(plans.error);
  /* `Date.now()` at render: the list is re-read often enough that a snooze
     expiring between two renders is not worth a timer, and a timer that woke
     the workbench up to show one row would be the wrong trade. */
  const now = Date.now();
  const items = (plans.data ?? []).filter(
    // `== null` on purpose: the field is `?: string | null`, so an absent key
    // and an explicit null both mean 「没有被推迟」.
    (plan) => plan.snoozed_until == null || Date.parse(plan.snoozed_until) <= now,
  );

  /* The heading is outside every branch: a block that disappears while it
     loads makes the whole workbench jump as five queries land at five
     different moments. Only the body swaps. */
  return (
    <section className="flex flex-col gap-3" data-home-block="plans">
      <div className="flex items-baseline gap-2">
        <h2 className="text-base font-medium">
          <Trans>待确认的剪辑单</Trans>
        </h2>
        {items.length === 0 ? null : (
          <span className="text-xs text-neutral-600">
            <Plural value={items.length} other="# 个等待确认" />
          </span>
        )}
      </div>

      {error !== null ? (
        <Alert variant="danger" action={{ label: <Trans>重试</Trans>, onAction: () => void plans.refetch() }}>
          <Trans>读不到待确认的剪辑单：{error}</Trans>
        </Alert>
      ) : plans.isPending ? (
        <div className="flex flex-col gap-2.5">
          <Skeleton />
          <Skeleton width="70%" />
        </div>
      ) : items.length === 0 ? (
        /* One line, not an `Empty`: an empty queue is the *good* outcome
           here, and a full-height box with a call to action would make a
           healthy workbench look like it needed attention. */
        <p className="text-xs leading-normal text-neutral-600">
          <Trans>没有等待确认的剪辑单。</Trans>
        </p>
      ) : (
        <>
          <ul className="flex flex-col gap-2.5">
            {items.slice(0, SHOWN).map((plan) => (
              <PlanRow
                key={plan.id}
                plan={plan}
                snoozing={snooze.isPending}
                onSnooze={(planId) => {
                  snooze.mutate({ planId, until: nextLocalMidnight() });
                }}
              />
            ))}
          </ul>
          {items.length > SHOWN ? (
            <RouteLink to="/agent">
              <Plural value={items.length - SHOWN} other="还有 # 个，去 Agent 面板看" />
            </RouteLink>
          ) : null}
        </>
      )}
    </section>
  );
}

function PlanRow({
  plan,
  onSnooze,
  snoozing,
}: {
  readonly plan: AgentPlanSummary;
  readonly onSnooze: (planId: string) => void;
  readonly snoozing: boolean;
}) {
  return (
    <li className="flex items-center justify-between gap-3 border border-divider p-3" data-plan={plan.id}>
      <div className="flex min-w-0 flex-col gap-1">
        <p className="truncate text-sm">{plan.title}</p>
        <p className="text-xs text-neutral-600">
          {/* Only what the summary carries. The board's subject line has no
              field — see the module comment. */}
          {formatShotDuration(plan.total_duration_seconds)}
          {' · '}
          <Plural value={plan.shot_count} other="# 个镜头" />
          {plan.origin_count > 0 ? (
            <>
              {' · '}
              <Plural value={plan.origin_count} other="依据 # 条证据" />
            </>
          ) : null}
        </p>
      </div>
      <div className="flex flex-none items-center gap-3">
        <Button
          variant="ghost"
          size="sm"
          disabled={snoozing}
          disabledReason={t`正在处理`}
          onClick={() => onSnooze(plan.id)}
        >
          <Trans>稍后处理</Trans>
        </Button>
        {/* A link, not a `Button` with `navigate` — it goes to an address, and a
            link is what a middle-click and a screen reader expect there. */}
        <RouteLink to={`/agent?plan=${encodeURIComponent(plan.id)}`}>
          <Trans>审阅剪辑单</Trans>
        </RouteLink>
      </div>
    </li>
  );
}
