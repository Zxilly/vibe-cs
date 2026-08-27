/*
 * Domain layer — agent/, §4.5.3 rule ③: the revision decides whether a proposal
 * still holds.
 *
 * 「Agent 每次提议带 basedOnRevision；用户手动编辑使 plan.revision++；
 *   basedOnRevision < plan.revision 的未处理变更立即变 stale——卡片降到 55%
 *   不透明度、「接受」按钮禁用、标签写「已过期」，但内容仍可读（过期不等于错误，
 *   用户要据此判断是否值得重算）。已接受过的变更不受影响。」
 *
 * This is the only concurrency rule in the phase, so it is one pure function
 * and one table, in the `unit` project, rather than a `useMemo` in three
 * panels. The three page blocks (`pages/agent/agentContract.ts`) call
 * `markStale` and read `PLAN_CHANGE_AFFORDANCE`; none of them re-derives either.
 *
 * ── Why the comparison is `<` and not `!==` ───────────────────────────────
 *
 * The revision is server-authoritative and strictly increasing (`AgentPlan`,
 * dto.ts) — `applyAgentPlanEdit` is a conditional write that rejects with 409
 * when `expected_revision` is behind. So a proposal can only ever be based on a
 * revision that is *older*, and a base that is somehow newer than the plan the
 * client holds means the client's copy is stale, not the proposal. Marking the
 * proposal stale in that case would tell the user the wrong thing — the fix is
 * to refetch the plan, which invalidation already does.
 *
 * ── Why staleness is not stored ───────────────────────────────────────────
 *
 * `stale` is a *function of two numbers*, both of which the panel already
 * holds. Storing it would mean a card could be stale in state while the plan
 * on screen says otherwise, which is precisely the failure §4.5.3 is about.
 * `markStale` is therefore called on every render with the current revision;
 * it returns the same object identity when nothing changes, so it is cheap
 * enough to do that.
 */

import { msg } from '@lingui/core/macro';
import type { MessageDescriptor } from '@lingui/core';

import { PLAN_CHANGE_STATE, type PlanChange, type PlanChangeSet, type PlanChangeState } from './types';

/**
 * Whether a change set was computed against an older plan than the one on
 * screen. A change set whose base equals the current revision is current; one
 * whose base is ahead is treated as current too (see the header).
 */
export function changeSetIsStale(changeSet: PlanChangeSet, currentRevision: number): boolean {
  return changeSet.basedOnRevision < currentRevision;
}

/**
 * §4.5.3 rule ③, applied.
 *
 * Every **unhandled** change of a change set whose base is behind becomes
 * `stale`. `accepted` and `rejected` are left exactly as they are — the user
 * already decided, and an accepted change has already been written into the
 * plan (that write is one of the things that moved the revision in the first
 * place). An already-`stale` change stays `stale`.
 *
 * Returns the same object when nothing changes, so a panel can call it on every
 * render without invalidating memoised children.
 */
export function markStale(changeSet: PlanChangeSet, currentRevision: number): PlanChangeSet {
  if (!changeSetIsStale(changeSet, currentRevision)) return changeSet;

  let changed = false;
  const changes = changeSet.changes.map((change) => {
    if (change.state !== 'pending') return change;
    changed = true;
    return { ...change, state: 'stale' as const };
  });

  return changed ? { ...changeSet, changes } : changeSet;
}

/** The single-change form, for a card that is handed one change and the plan. */
export function markChangeStale(change: PlanChange, stale: boolean): PlanChange {
  if (!stale || change.state !== 'pending') return change;
  return { ...change, state: 'stale' };
}

/** How many changes still need a decision — the toolbar's 「3 项变更待处理」. */
export function pendingChangeCount(changeSet: PlanChangeSet): number {
  return changeSet.changes.filter((change) => change.state === 'pending').length;
}

/* ── what a card in each state looks like ────────────────────────────────── */

/**
 * The one description of a change card's affordances, so 「过期卡片长什么样」 is
 * not written three times.
 *
 * `className` is a Tailwind utility rather than a raw number because the three
 * consumers are all React components; `STALE_OPACITY_PERCENT` is exported
 * beside it for the tests and for anything that needs the number itself.
 * **`hidden` is not a field on purpose**: an expired card is never hidden and
 * never truncated. 「过期不等于错误」 — the body stays fully legible so the user
 * can judge whether a recompute is worth it.
 */
export interface PlanChangeAffordance {
  /** Applied to the card root. Empty for every state but `stale`. */
  readonly className: string;
  readonly acceptDisabled: boolean;
  readonly rejectDisabled: boolean;
  /** The status chip, or `null` when the card carries none (`pending`). */
  readonly statusLabel: MessageDescriptor | null;
  /**
   * Why 「接受」 is disabled, for `Button`'s `disabledReason` — 「不隐藏、
   * 不静默失败」. `null` whenever accept is enabled.
   */
  readonly acceptDisabledReason: MessageDescriptor | null;
}

/** §4.5.3's 55%, as the number, for tests and for non-Tailwind consumers. */
export const STALE_OPACITY_PERCENT = 55;

/** Tailwind's `opacity-*` takes the percentage directly (v4). */
export const STALE_OPACITY_CLASS = 'opacity-55';

/**
 * Total over `PlanChangeState`, so a fifth state cannot be added without
 * deciding what its card does.
 *
 * `rejected` keeps 「接受」 enabled: the 2a board draws 「撤销拒绝」 on a rejected
 * card, and un-rejecting is the same act as accepting it now. `accepted`
 * disables both — the change is already in the plan, and taking it back is an
 * ordinary plan edit, not a change-card affordance.
 */
export const PLAN_CHANGE_AFFORDANCE: Readonly<Record<PlanChangeState, PlanChangeAffordance>> = {
  pending: {
    className: '',
    acceptDisabled: false,
    rejectDisabled: false,
    statusLabel: null,
    acceptDisabledReason: null,
  },
  accepted: {
    className: '',
    acceptDisabled: true,
    rejectDisabled: true,
    statusLabel: PLAN_CHANGE_STATE.accepted.label,
    acceptDisabledReason: msg`这条变更已经接受过了`,
  },
  rejected: {
    className: '',
    acceptDisabled: false,
    rejectDisabled: true,
    statusLabel: PLAN_CHANGE_STATE.rejected.label,
    acceptDisabledReason: null,
  },
  stale: {
    className: STALE_OPACITY_CLASS,
    acceptDisabled: true,
    rejectDisabled: false,
    statusLabel: PLAN_CHANGE_STATE.stale.label,
    acceptDisabledReason: msg`这条变更基于方案旧版本；读取最新方案后可重新应用`,
  },
};

/** Sugar for a card that has a change in hand. */
export function planChangeAffordance(change: PlanChange): PlanChangeAffordance {
  return PLAN_CHANGE_AFFORDANCE[change.state];
}
