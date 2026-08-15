/*
 * pages/agent — what `?mode=takes` can honestly show.
 *
 * ── There is no Take model, and this file does not invent one ─────────────
 *
 * `agentContract.ts` gap 8: §4.5.2's `Take` and `Composition` — the 2c board's
 * three branches and its 合成结果 panel — have **no wire type and no route**,
 * and `AgentWorkspaceSettings.take_limit` limits something the API cannot list.
 * So this module does not build takes. What it does is name the versions of a
 * plan that *do* exist on the wire, which is exactly two:
 *
 *   `agent_baseline`   the immutable Agent version and its revision
 *   the plan itself    the current shots and the current revision
 *
 * Both are `AgentPlanShot[]`, both carry a revision the server owns, and
 * comparing them is the half of 2c that has data — 「反复改怎么不丢版本」. The
 * other half (branching, and picking one shot from each branch) is not drawn:
 * `TakeCard` gets no `onUseWhole`, `CompositionRow` is not rendered at all, and
 * the block prints one sentence saying the branch model is missing rather than
 * a panel that pretends to compose.
 *
 * The two are deliberately **not** labelled 「Take A / Take B」. They are 「Agent
 * 版本」 and 「当前」, because that is what they are; borrowing the take
 * vocabulary for two revisions is how a made-up schema starts looking real.
 *
 * ── Which facts are printed ──────────────────────────────────────────────
 *
 * Only ones that are fields. Length and shot count come from
 * `domain/agent/planStripLayout`; 「标注风险的镜头」 counts `risks.length > 0` and
 * 「你改过的镜头」 counts `source === 'user'`. The artboard's 「运动镜头」 and
 * 「击杀证据覆盖」 rows are **not** here: the first would need a moving /
 * stationary split of `camera_style` that nobody has decided (is a POV that
 * follows a player a moving shot?), and the second would need kill evidence a
 * plan does not carry.
 */

import { planDuration, planShotCount } from '../../domain/agent';
import type { AgentPlan, AgentPlanShot } from '../../shared/desktop/dto';

/** One version of one plan. `id` is a DOM key, not a server identifier. */
export interface PlanVersion {
  readonly id: 'baseline' | 'current';
  readonly revision: number;
  readonly shots: readonly AgentPlanShot[];
  /** ISO stamp: the baseline's capture, or the plan's last write. */
  readonly at: string;
  /** The version the rest of the page is editing. */
  readonly current: boolean;
}

/**
 * The plan's versions, oldest first.
 *
 * One entry when the plan has never moved off the Agent's version — there is
 * nothing to compare, and a second column repeating the first is a comparison
 * that says nothing. Two once a revision separates them.
 */
export function planVersions(plan: AgentPlan): readonly PlanVersion[] {
  const current: PlanVersion = {
    id: 'current',
    revision: plan.revision,
    shots: plan.shots,
    at: plan.updated_at,
    current: true,
  };

  if (plan.agent_baseline.revision >= plan.revision) return [current];

  return [
    {
      id: 'baseline',
      revision: plan.agent_baseline.revision,
      shots: plan.agent_baseline.shots,
      at: plan.agent_baseline.captured_at,
      current: false,
    },
    current,
  ];
}

/** The rows under a version card. Every one of them is a wire field. */
export interface PlanVersionFacts {
  readonly durationSeconds: number;
  readonly shotCount: number;
  /** Shots carrying at least one `risks` entry. */
  readonly riskyShotCount: number;
  /** Shots whose `source` is `user` — 「你改过」 (§4.5.3 ②). */
  readonly userShotCount: number;
  /** Against `baseline`; `null` when this *is* the baseline, or there is none. */
  readonly durationDeltaSeconds: number | null;
  readonly shotCountDelta: number | null;
}

export function planVersionFacts(
  version: PlanVersion,
  baseline: PlanVersion | null,
): PlanVersionFacts {
  const durationSeconds = planDuration(version.shots);
  const shotCount = planShotCount(version.shots);
  const comparable = baseline !== null && baseline.id !== version.id;

  return {
    durationSeconds,
    shotCount,
    riskyShotCount: version.shots.filter((shot) => shot.risks.length > 0).length,
    userShotCount: version.shots.filter((shot) => shot.source === 'user').length,
    durationDeltaSeconds: comparable ? durationSeconds - planDuration(baseline.shots) : null,
    shotCountDelta: comparable ? shotCount - planShotCount(baseline.shots) : null,
  };
}

/**
 * 「+1」/「−1」/「±0」 for a whole number.
 *
 * `domain/agent/shotFormat` owns the signed *seconds* form and uses U+2212 for
 * the minus, because a hyphen next to a monospace digit reads as a hyphen. A
 * count needs the same glyph and none of the decimal, so it is spelled here
 * rather than by widening a formatter whose name says seconds.
 */
export function formatSignedCount(value: number): string {
  if (!Number.isFinite(value) || value === 0) return '±0';
  const sign = value > 0 ? '+' : '−';
  return `${sign}${String(Math.abs(Math.trunc(value)))}`;
}
