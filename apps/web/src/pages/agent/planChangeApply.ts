/*
 * pages/agent — accepting one of the Agent's changes, and knowing when it
 * cannot be accepted at all (§4.5.3 rules ① and ③).
 *
 * ── Accepting is an edit, and only an edit ────────────────────────────────
 *
 * 「接受变更不触发录制」. Everything below returns a plain `ShotEditResult` — the
 * same shape a manual edit produces — which the panel hands to
 * `editNotifier.record`. There is no branch here that could reach a command, and
 * `planEdit.interaction.test.tsx` walks the client to prove the panel keeps that
 * property once the two are wired together.
 *
 * That also settles what an accepted change does to `source`: **nothing**. The
 * shot was designed by the Agent and it still is; stamping it 「你改过」 because
 * the user pressed 接受 would put the user's name on the Agent's work. The wire
 * cannot record 「我接受了 Agent 的建议」 as distinct from 「我自己改的」 at all
 * (`agentContract.ts`, gap 3) — this file simply does not pretend otherwise.
 *
 * ── Why half the ops cannot be applied ────────────────────────────────────
 *
 * `AgentSessionProposal.payload` is `unknown` and `domain/agent/types.ts` reads
 * out of it only what is unambiguous: an op, a target shot, some prose, and an
 * optional signed `deltaSeconds`. That is enough to *carry out* two of the four
 * ops and no more:
 *
 *   shorten  duration + delta — arithmetic on a number both sides agree about
 *   delete   a soft delete of a shot named by id
 *   replace  needs the replacement shot. The payload has prose, not a shot.
 *   insert   needs the new shot. Same.
 *
 * So 接受 on a `replace` or an `insert` is disabled **with the reason written
 * on it** rather than hidden or, worse, wired to something that guesses. 「不隐藏、
 * 不静默失败」 applies to a button that cannot work as much as to one that failed.
 */

import { msg } from '@lingui/core/macro';
import type { MessageDescriptor } from '@lingui/core';

import { PLAN_CHANGE_OPS, formatShotDuration } from '../../domain/agent';
import type { PlanChange, PlanChangeOp } from '../../domain/agent';
import type { AgentPlanShot } from '../../shared/desktop/dto';

import { removeShot, replaceShot, shotPosition, type ShotEditResult } from './planEditModel';

/**
 * Whether an op can be carried out at all, before any particular plan is
 * consulted. Total over `PlanChangeOp`, so a fifth op has to declare itself.
 */
export const PLAN_CHANGE_IS_APPLICABLE: Readonly<Record<PlanChangeOp, boolean>> = {
  shorten: true,
  delete: true,
  replace: false,
  insert: false,
};

/** The ops the panel can actually carry out, for the tests to walk. */
export const APPLICABLE_PLAN_CHANGE_OPS: readonly PlanChangeOp[] = PLAN_CHANGE_OPS.filter(
  (op) => PLAN_CHANGE_IS_APPLICABLE[op],
);

export interface ChangeApplicability {
  readonly applicable: boolean;
  /** Why not. `null` exactly when `applicable` is true. */
  readonly reason: MessageDescriptor | null;
}

const APPLICABLE: ChangeApplicability = { applicable: true, reason: null };

/**
 * Whether 接受 can do anything to *this* plan.
 *
 * Read alongside `PLAN_CHANGE_AFFORDANCE`, never instead of it: the affordance
 * answers 「这张卡处于什么状态」 (accepted / rejected / stale) and this answers
 * 「就算状态允许，这条能落到方案上吗」. The panel disables 接受 when either says
 * so, and prints the affordance's reason first — a stale card should say it is
 * stale before it says the payload is thin.
 */
export function changeApplicability(
  change: PlanChange,
  shots: readonly AgentPlanShot[],
): ChangeApplicability {
  if (!PLAN_CHANGE_IS_APPLICABLE[change.op]) {
    return { applicable: false, reason: msg`这条变更只给了说明，没有给出可以直接落到方案上的内容` };
  }

  const shot = shots.find((candidate) => candidate.id === change.targetShotId);
  if (shot === undefined) {
    return { applicable: false, reason: msg`这条变更指向的镜头已经不在方案里了` };
  }

  if (change.op === 'delete') {
    return shot.removed_by === null
      ? APPLICABLE
      : { applicable: false, reason: msg`这个镜头已经删除了` };
  }

  if (change.deltaSeconds === null) {
    return { applicable: false, reason: msg`这条变更没有给出秒数，无法直接应用` };
  }
  if (shot.duration_seconds + change.deltaSeconds < 0) {
    return { applicable: false, reason: msg`按这条变更算出来的时长会小于 0` };
  }

  return APPLICABLE;
}

/**
 * Carries the change out. `null` whenever `changeApplicability` says no, so a
 * caller that forgot to check still cannot write a guess into the plan.
 *
 * A `shorten` becomes an ordinary `duration_seconds` line in the notice, which
 * is the truth: what reaches the server is a plan whose second shot is now 3
 * seconds long, and the session already holds the proposal that asked for it.
 */
export function applyPlanChange(
  shots: readonly AgentPlanShot[],
  change: PlanChange,
): ShotEditResult | null {
  if (!changeApplicability(change, shots).applicable) return null;

  if (change.op === 'delete') return removeShot(shots, change.targetShotId);

  const shot = shots.find((candidate) => candidate.id === change.targetShotId);
  if (shot === undefined || change.deltaSeconds === null) return null;

  const duration = shot.duration_seconds + change.deltaSeconds;
  const next: AgentPlanShot = { ...shot, duration_seconds: duration };

  return {
    shots: replaceShot(shots, next),
    changes: [
      {
        shot: shotPosition(shots, change.targetShotId),
        op: 'updated',
        field: 'duration_seconds',
        from: formatShotDuration(shot.duration_seconds),
        to: formatShotDuration(duration),
      },
    ],
  };
}
