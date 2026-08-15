/*
 * Domain layer, 2 of 3 — agent/, the proportional shot strip's arithmetic.
 *
 * The horizontal band of labelled blocks is on **every** Agent artboard: 07 打开
 * 方案时的镜头带, 2a 的方案对照两行, 2c 的三条 take, 手动编辑那张的顶部, 新建会话
 * 那张的顶部. It is always the same picture — one block per shot, width in
 * proportion to its length, a 留白 block at the head, and a deleted shot that
 * keeps its slot and is drawn dashed.
 *
 * The widths are the whole of the component, so they are a pure function here
 * and `PlanStrip.tsx` only paints. That also lets the awkward cases be settled
 * once, in the `unit` project, instead of inside a `useMemo` nobody can call:
 *
 *   · **A removed shot keeps its width.** The 2a compare row draws 「04 已删除」
 *     at the same 15% as the row above it, and that is what makes the two rows
 *     comparable at all — a strip that reflowed on delete would move every
 *     block and the eye would have to re-find them. So the denominator counts
 *     removed shots; `planDuration` (what the toolbar prints) does not.
 *   · **Zero-length input does not divide by zero.** A plan whose shots all
 *     report 0 seconds still has to draw one block per shot, so the widths fall
 *     back to an even split. This is not hypothetical: `duration_seconds` is a
 *     server field and a freshly inserted shot can arrive at 0.
 *   · **Negative is clamped to 0**, not dropped. A block with no width is still
 *     a block in the count, and dropping it would silently renumber the rest.
 *
 * ── The four tones ────────────────────────────────────────────────────────
 *
 * The artboards paint the band in four fills: neutral for 留白, two accent
 * steps for ordinary shots, the flat accent for the one long 主体段, and a
 * dashed outline for a deleted shot. Two accent steps that differ only by
 * length are a hue carrying a fact, which §6.2 forbids, and nothing in the wire
 * says which shot is the 主体段 — so the ramp is reduced to one rule that can be
 * derived and stated: **the longest shot is the main one.** Everything else is
 * an ordinary shot. The block prints its own number and title in every tone, so
 * the fill is never the only thing that separates them.
 */

import type { AgentPlanShot } from '../../shared/desktop/dto';

/** What a block is: the lead-in, an ordinary shot, the longest one, a deleted one. */
export type PlanStripTone = 'lead' | 'shot' | 'main' | 'removed';

export interface PlanStripSegment {
  /** `AgentPlanShot.id`, or `lead` for the 留白 block, which is not a shot. */
  readonly id: string;
  /** One-based, matching the 「02」 the cards print. `null` for the lead-in. */
  readonly index: number | null;
  readonly label: string;
  readonly durationSeconds: number;
  /** 0–100, summing to 100 across the returned segments. */
  readonly percent: number;
  readonly tone: PlanStripTone;
}

export interface PlanStripOptions {
  /**
   * The 留白 block at the head. The artboards draw it at 7–8% of the strip and
   * label it 「留白」; it is a real part of the cut, not padding. Omitted when 0.
   */
  readonly leadSeconds?: number | undefined;
  /** What the lead-in block says. Copy belongs to the caller, not here. */
  readonly leadLabel?: string | undefined;
}

function safeSeconds(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 0;
}

/**
 * The length the toolbar prints — 「42.0 秒」. **Removed shots do not count**:
 * the strip keeps their slot so the two rows line up, but a shot the user
 * deleted is not in the video, and a total that included it would be a number
 * the user could not reconcile with what they are about to record.
 */
export function planDuration(shots: readonly AgentPlanShot[], options: PlanStripOptions = {}): number {
  const lead = safeSeconds(options.leadSeconds ?? 0);
  return shots.reduce(
    (total, shot) => (shot.removed_by === null ? total + safeSeconds(shot.duration_seconds) : total),
    lead,
  );
}

/** How many shots are still in the cut — 「4 个镜头」. */
export function planShotCount(shots: readonly AgentPlanShot[]): number {
  return shots.filter((shot) => shot.removed_by === null).length;
}

/**
 * One block per shot, plus the lead-in when there is one.
 *
 * The returned percentages always sum to 100 (to within floating-point error);
 * a caller writes them straight into a flex-basis and gets the artboard's band.
 */
export function planStripSegments(
  shots: readonly AgentPlanShot[],
  options: PlanStripOptions = {},
): readonly PlanStripSegment[] {
  const lead = safeSeconds(options.leadSeconds ?? 0);

  const shotSegments = shots.map((shot, position) => ({
    id: shot.id,
    index: position + 1,
    label: shot.title,
    durationSeconds: safeSeconds(shot.duration_seconds),
    removed: shot.removed_by !== null,
  }));

  /* The denominator counts removed shots — see the header. */
  const total = lead + shotSegments.reduce((sum, segment) => sum + segment.durationSeconds, 0);
  const blockCount = shotSegments.length + (lead > 0 ? 1 : 0);
  if (blockCount === 0) return [];

  /* Every duration was zero (or there are none but a zero lead): fall back to an
     even split rather than dividing by zero and painting NaN. */
  const even = 100 / blockCount;
  const share = (seconds: number): number => (total > 0 ? (seconds / total) * 100 : even);

  const longest = shotSegments.reduce(
    (best, segment) => (segment.durationSeconds > best ? segment.durationSeconds : best),
    0,
  );

  const segments: PlanStripSegment[] = [];
  if (lead > 0) {
    segments.push({
      id: 'lead',
      index: null,
      label: options.leadLabel ?? '',
      durationSeconds: lead,
      percent: share(lead),
      tone: 'lead',
    });
  }

  for (const segment of shotSegments) {
    segments.push({
      id: segment.id,
      index: segment.index,
      label: segment.label,
      durationSeconds: segment.durationSeconds,
      percent: share(segment.durationSeconds),
      /* `removed` wins over `main`: a deleted shot is not the主体段 of anything,
         and the dashed outline is the reading that has to survive. */
      tone: segment.removed ? 'removed' : segment.durationSeconds === longest && longest > 0 ? 'main' : 'shot',
    });
  }

  return segments;
}

/**
 * The 00:00 · 00:10 · 00:20 · 00:30 · 00:42 marks under the band.
 *
 * The artboards draw five, evenly spaced by *position*, with the last one
 * carrying the real total rather than a round number — which is why this cannot
 * be a 「every ten seconds」 rule: a 28.5-second plan would then end on 00:20 and
 * leave the strip's right edge unlabelled.
 */
export function stripRulerMarks(totalSeconds: number, count = 5): readonly number[] {
  const total = safeSeconds(totalSeconds);
  const marks = Math.max(2, Math.trunc(count));
  return Array.from({ length: marks }, (_, index) => (total * index) / (marks - 1));
}
