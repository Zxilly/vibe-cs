/*
 * Design system, layer 1 of 3 — multi-track timeline prototype (spec §0.5).
 *
 * 滑移 — 「片段在时间轴上位置不变，内部素材的 in/out 同时平移」.
 *
 * So `start` and `duration` are invariants of the operation, and `sourceIn` is
 * the only field that moves. The artboard's Inspector shows exactly the two
 * numbers this changes:
 *
 *   入点  00:00:04:08
 *   出点  00:00:32:02
 *
 * 28 s of footage taken from 4.13 s into a 42 s source: there is 4.13 s of
 * head to slip into and 9.87 s of tail. Past either the clip would show
 * frames that do not exist, so a slip clamps rather than refusing — dragging a
 * slip to the end of the source and holding is the normal gesture, and a
 * refusal there would feel like a bug.
 *
 * The clamp for a link group is the *intersection* of its members' ranges: an
 * A/V pair that slipped by different amounts would go out of sync, which is the
 * one failure a slip must never produce.
 */

import {
  clipSourceOut,
  getClip,
  getTrack,
  linkGroup,
  patchClips,
  refuse,
  slipRange,
  type Clip,
  type EditResult,
  type Timeline,
} from './timelineModel';
import { TIME_EPSILON } from './timeScale';

export interface SlipOptions {
  /** Slip the A/V partners by the same amount. Default true. */
  linked?: boolean;
}

export interface SlipResult extends EditResult {
  /** What actually happened, after the clamp. May be smaller than requested. */
  appliedDelta: number;
  /** How far the group could still slip, once this one is applied. */
  range: { min: number; max: number };
}

function slipRefusal(timeline: Timeline, reason: EditResult['reason']): SlipResult {
  return { ...refuse(timeline, reason ?? 'no-change'), appliedDelta: 0, range: { min: 0, max: 0 } };
}

/** The slip range shared by a whole link group: the tightest of its members. */
export function groupSlipRange(clips: readonly Clip[]): { min: number; max: number } {
  if (clips.length === 0) return { min: 0, max: 0 };
  let min = Number.NEGATIVE_INFINITY;
  let max = Number.POSITIVE_INFINITY;
  for (const clip of clips) {
    const range = slipRange(clip);
    min = Math.max(min, range.min);
    max = Math.min(max, range.max);
  }
  // A valid clip always has min ≤ 0 ≤ max, so the intersection cannot invert;
  // the guard is here because an invalid document should degrade to "no slip"
  // rather than to a negative range that would move the clip the wrong way.
  return min > max ? { min: 0, max: 0 } : { min, max };
}

/**
 * Slides the source window of a clip by `deltaSeconds`. Positive moves the
 * window later in the source — the same direction as dragging the *content*
 * left under a fixed clip, which is how a slip tool is normally driven.
 */
export function slipClip(
  timeline: Timeline,
  clipId: string,
  deltaSeconds: number,
  options: SlipOptions = {},
): SlipResult {
  const { linked = true } = options;

  const clip = getClip(timeline, clipId);
  if (clip === undefined) return slipRefusal(timeline, 'unknown-clip');

  const group = linked ? linkGroup(timeline, clipId) : [clip];
  if (group.some((member) => getTrack(timeline, member.trackId)?.locked === true)) {
    return slipRefusal(timeline, 'track-locked');
  }

  const range = groupSlipRange(group);
  const applied = Math.min(range.max, Math.max(range.min, deltaSeconds));

  if (Math.abs(applied) < TIME_EPSILON) {
    // Distinct from `out-of-bounds`: the clip is fine, the *source* has run out.
    return { ...refuse(timeline, 'no-headroom'), appliedDelta: 0, range };
  }

  const patches = new Map<string, Partial<Clip>>(
    group.map((member) => [member.id, { sourceIn: member.sourceIn + applied }]),
  );

  return {
    timeline: patchClips(timeline, patches),
    applied: true,
    appliedDelta: applied,
    range: { min: range.min - applied, max: range.max - applied },
  };
}

/**
 * What the Inspector prints while a slip is in progress: the two timecodes the
 * artboard draws, for the clip the pointer is on.
 */
export function slipPreview(clip: Clip, deltaSeconds: number): { sourceIn: number; sourceOut: number } {
  const range = slipRange(clip);
  const applied = Math.min(range.max, Math.max(range.min, deltaSeconds));
  return { sourceIn: clip.sourceIn + applied, sourceOut: clipSourceOut(clip) + applied };
}
