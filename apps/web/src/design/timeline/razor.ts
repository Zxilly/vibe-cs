/*
 * Design system, layer 1 of 3 — multi-track timeline prototype (spec §0.5).
 *
 * 剃刀 — 「在指定时间点把一个片段切成两个，两半的 in/out 点正确」.
 *
 * The arithmetic is three lines; the parts that are easy to get wrong are the
 * three around it:
 *
 *   1. the source window. The right half does not start at the source's in
 *      point, it starts `time - clip.start` further in. Getting this wrong
 *      shows up as a visible jump at the cut, which is exactly the bug a
 *      prototype exists to rule out. `sourceDuration` is untouched — both
 *      halves still refer to the same media file.
 *   2. the link. If V1 and its A1 partner both carry linkId `av-1` and both
 *      are cut, all four halves would share `av-1` and dragging the left video
 *      would drag the right audio. The left halves keep the group, the right
 *      halves get a new one.
 *   3. the edges. A cut exactly on a clip boundary is not a cut. It is
 *      refused, not silently turned into a zero-length clip.
 */

import {
  clipContains,
  clipEnd,
  clipIdSet,
  getClip,
  getTrack,
  linkGroup,
  linkIdSet,
  mintId,
  refuse,
  withClips,
  type Clip,
  type EditResult,
  type Timeline,
} from './timelineModel';
import { TIME_EPSILON } from './timeScale';

export interface RazorResult extends EditResult {
  /** Ids of the halves that stayed: one per clip cut, the original id. */
  leftIds: string[];
  /** Ids minted for the right halves, in the same order. */
  rightIds: string[];
}

function razorRefusal(timeline: Timeline, reason: EditResult['reason']): RazorResult {
  return { ...refuse(timeline, reason ?? 'no-change'), leftIds: [], rightIds: [] };
}

interface SplitPlan {
  left: Clip;
  right: Clip;
}

/**
 * Cuts one clip. `takenClipIds` and `takenLinkIds` are threaded through so a
 * multi-clip razor mints unique ids without a mutable counter.
 */
function planSplit(
  clip: Clip,
  time: number,
  takenClipIds: Set<string>,
  takenLinkIds: Set<string>,
  linkRemap: Map<string, string>,
): SplitPlan {
  const headDuration = time - clip.start;
  const rightId = mintId(takenClipIds, clip.id);
  takenClipIds.add(rightId);

  let rightLinkId: string | undefined;
  if (clip.linkId !== undefined) {
    // Every clip of one link group must land in the *same* new group, so the
    // remap is shared across the whole razor pass.
    const existing = linkRemap.get(clip.linkId);
    if (existing === undefined) {
      rightLinkId = mintId(takenLinkIds, clip.linkId);
      takenLinkIds.add(rightLinkId);
      linkRemap.set(clip.linkId, rightLinkId);
    } else {
      rightLinkId = existing;
    }
  }

  return {
    left: { ...clip, duration: headDuration },
    right: {
      ...clip,
      id: rightId,
      start: time,
      duration: clip.duration - headDuration,
      sourceIn: clip.sourceIn + headDuration,
      ...(rightLinkId === undefined ? {} : { linkId: rightLinkId }),
    },
  };
}

export interface SplitOptions {
  /** Cut the A/V partners at the same instant. Default true. */
  linked?: boolean;
}

/**
 * Cuts `clipId` at `time`. The left half keeps the original id, so a selection
 * and an undo stack survive the cut.
 */
export function splitClipAt(
  timeline: Timeline,
  clipId: string,
  time: number,
  options: SplitOptions = {},
): RazorResult {
  const { linked = true } = options;
  const clip = getClip(timeline, clipId);
  if (clip === undefined) return razorRefusal(timeline, 'unknown-clip');

  const group = linked ? linkGroup(timeline, clipId) : [clip];
  const cuttable = group.filter((member) => clipContains(member, time));
  if (cuttable.length === 0) return razorRefusal(timeline, 'out-of-bounds');
  if (cuttable.some((member) => getTrack(timeline, member.trackId)?.locked === true)) {
    return razorRefusal(timeline, 'track-locked');
  }

  return applySplits(timeline, cuttable, time);
}

/**
 * The toolbar's 剃刀 at the playhead: cuts every clip the instant crosses.
 * Link groups need no special handling — if a partner crosses `time` it is in
 * the list already, and the shared link remap keeps the right halves together.
 */
export function razorAt(
  timeline: Timeline,
  time: number,
  options: { trackIds?: ReadonlySet<string>; clipIds?: ReadonlySet<string> } = {},
): RazorResult {
  const { trackIds, clipIds } = options;
  const cuttable = timeline.clips.filter((clip) => {
    if (trackIds !== undefined && !trackIds.has(clip.trackId)) return false;
    if (clipIds !== undefined && !clipIds.has(clip.id)) return false;
    if (getTrack(timeline, clip.trackId)?.locked === true) return false;
    return clipContains(clip, time);
  });

  if (cuttable.length === 0) return razorRefusal(timeline, 'out-of-bounds');
  return applySplits(timeline, cuttable, time);
}

function applySplits(timeline: Timeline, cuttable: readonly Clip[], time: number): RazorResult {
  const takenClipIds = clipIdSet(timeline);
  const takenLinkIds = linkIdSet(timeline);
  const linkRemap = new Map<string, string>();

  const plans = cuttable.map((clip) => planSplit(clip, time, takenClipIds, takenLinkIds, linkRemap));
  const replaced = new Map(plans.map((plan) => [plan.left.id, plan.left]));

  const clips = timeline.clips.map((clip) => replaced.get(clip.id) ?? clip);
  const next = withClips(timeline, [...clips, ...plans.map((plan) => plan.right)]);

  return {
    timeline: next,
    applied: true,
    leftIds: plans.map((plan) => plan.left.id),
    rightIds: plans.map((plan) => plan.right.id),
  };
}

/**
 * Whether a razor at `time` would do anything — what the razor cursor should
 * read to decide between a live blade and a dead one.
 */
export function canRazorAt(timeline: Timeline, time: number, trackIds?: ReadonlySet<string>): boolean {
  return timeline.clips.some(
    (clip) =>
      (trackIds === undefined || trackIds.has(clip.trackId)) &&
      getTrack(timeline, clip.trackId)?.locked !== true &&
      clipContains(clip, time),
  );
}

/**
 * The seam times of a track, used by the razor cursor and by the tests: every
 * clip edge, deduplicated.
 */
export function seamsOnTrack(timeline: Timeline, trackId: string): number[] {
  const seams: number[] = [];
  for (const clip of timeline.clips) {
    if (clip.trackId !== trackId) continue;
    for (const time of [clip.start, clipEnd(clip)]) {
      if (!seams.some((existing) => Math.abs(existing - time) < TIME_EPSILON)) seams.push(time);
    }
  }
  return seams.sort((a, b) => a - b);
}
