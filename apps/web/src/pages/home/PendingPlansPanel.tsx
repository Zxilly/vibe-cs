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
 *   ✗ 预计 42 秒      no duration on the summary — it is the sum of the shots'
 *                     durations, and the summary deliberately omits the shot
 *                     bodies (that is what makes it a summary)
 *   ✗ Kael · Mirage   no Demo or player binding on a plan at all (§10.5 gap 1)
 *
 * So the row prints the title, the shot count and the evidence count, and does
 * **not** print a duration or a subject. Fetching every plan's full body to
 * total its shots would be N requests to render a list, and inventing the
 * subject line is not available at any price.
 *
 * ── 「稍后处理」 is not drawn ─────────────────────────────────────────────
 *
 * The board has 审阅方案 and 稍后处理. There is no "snooze" anywhere in the
 * plan model — no dismissed-at, no reminder — so a button labelled 稍后处理
 * would either do nothing or hide the row until reload, which is worse than
 * not offering it. Recorded as a gap.
 */

import { Plural, Trans } from '@lingui/react/macro';

import { Skeleton } from '../../design/data';
import { Notice } from '../../design/feedback';
import { useAgentPlanList } from '../../data/plans';
import { dataErrorMessage } from '../../data/errors';
import type { AgentPlanSummary } from '../../shared/desktop/dto';
import { RouteLink } from '../RouteLink';

/** Enough to show the queue without turning the workbench into a list page. */
const SHOWN = 3;

export function PendingPlansPanel() {
  const plans = useAgentPlanList({ status: 'awaiting_confirmation', limit: 10 });
  const error = dataErrorMessage(plans.error);
  const items = plans.data ?? [];

  /* The heading is outside every branch: a block that disappears while it
     loads makes the whole workbench jump as five queries land at five
     different moments. Only the body swaps. */
  return (
    <section className="flex flex-col gap-3" data-home-block="plans">
      <div className="flex items-baseline gap-2">
        <h2 className="text-base font-medium">
          <Trans>待确认的方案</Trans>
        </h2>
        {items.length === 0 ? null : (
          <span className="text-xs text-neutral-600">
            <Plural value={items.length} other="# 个等待确认" />
          </span>
        )}
      </div>

      {error !== null ? (
        <Notice tone="danger" action={{ label: <Trans>重试</Trans>, onAction: () => void plans.refetch() }}>
          <Trans>读不到待确认的方案：{error}</Trans>
        </Notice>
      ) : plans.isPending ? (
        <div className="flex flex-col gap-2.5">
          <Skeleton />
          <Skeleton width="70%" />
        </div>
      ) : items.length === 0 ? (
        /* One line, not an `EmptyState`: an empty queue is the *good* outcome
           here, and a full-height box with a call to action would make a
           healthy workbench look like it needed attention. */
        <p className="text-xs leading-normal text-neutral-600">
          <Trans>没有等待确认的方案。</Trans>
        </p>
      ) : (
        <>
          <ul className="flex flex-col gap-2.5">
            {items.slice(0, SHOWN).map((plan) => (
              <PlanRow key={plan.id} plan={plan} />
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

function PlanRow({ plan }: { readonly plan: AgentPlanSummary }) {
  return (
    <li className="flex items-center justify-between gap-3 border border-divider p-3" data-plan={plan.id}>
      <div className="flex min-w-0 flex-col gap-1">
        <p className="truncate text-sm">{plan.title}</p>
        <p className="text-xs text-neutral-600">
          {/* Only what the summary carries. The board's 「预计 42 秒」 and its
              subject line have no field — see the module comment. */}
          <Plural value={plan.shot_count} other="# 个镜头" />
          {plan.origin_count > 0 ? (
            <>
              {' · '}
              <Plural value={plan.origin_count} other="依据 # 条证据" />
            </>
          ) : null}
        </p>
      </div>
      {/* A link, not a `Button` with `navigate` — it goes to an address, and a
          link is what a middle-click and a screen reader expect there. */}
      <RouteLink to={`/agent?plan=${encodeURIComponent(plan.id)}`} className="flex-none">
        <Trans>审阅方案</Trans>
      </RouteLink>
    </li>
  );
}
