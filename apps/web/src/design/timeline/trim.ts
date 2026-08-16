/*
 * Design system, layer 1 of 3 — multi-track timeline (spec §0.5, phase 3f-2).
 *
 * 修剪 — dragging a clip's left or right edge to change its in or out point.
 * README gap 1: the operation an NLE is used for more than any other, absent
 * from the prototype because §0.5's six did not name it.
 *
 * ## What moves, and what does not
 *
 *   trim in   `start` and `sourceIn` travel together, `duration` absorbs the
 *             difference. The frame under the cursor stays the frame under the
 *             cursor — that is the whole feel of the gesture.
 *   trim out  only `duration`. `start` and `sourceIn` are untouched.
 *
 * Trimming is therefore the exact complement of 滑移: a slip moves the window
 * and keeps its length, a trim keeps one edge of the window and changes its
 * length. Between them they cover every way a clip's relationship to its
 * source can change without re-cutting it.
 *
 * ## Four things bound a trim, and they are not interchangeable
 *
 *   1. **source** — a clip cannot show frames the media does not have.
 *      `trimHeadroom` is the answer, and it is divided by `speed`: at 200% a
 *      second of timeline eats two seconds of source, so two seconds of
 *      remaining source buy only one second of clip.
 *   2. **the neighbour** — the clip on the same track on that side. Trimming
 *      into it would overlap, which this editor refuses everywhere else too
 *      (`dragMove`'s default policy), so it refuses here.
 *   3. **t = 0** — a trim in cannot take `start` negative.
 *   4. **one frame** — a clip shorter than a frame is not a clip. `too-short`
 *      says so rather than silently producing a zero-width sliver, which is
 *      the same call `razor` makes at a clip boundary.
 *
 * All four are *clamps*, not refusals: dragging an edge to the end of the
 * source and holding is the normal gesture, exactly as in `slip.ts`. A refusal
 * is reserved for the cases where nothing at all could happen — a locked
 * track, an unknown clip, a drag that has no room in the direction asked for.
 *
 * ## The link group
 *
 * An A/V pair trims together, and by the tightest of the members' ranges — the
 * same intersection `groupSlipRange` takes, for the same reason. A pair whose
 * video was trimmed further than its audio is out of sync, and the user
 * dragging one edge did not ask for that.
 *
 * Members are trimmed by the same *delta*, not to the same time: a linked pair
 * whose clips deliberately start a few frames apart (a J-cut) keeps its
 * offset. Trimming them to a common edge would silently destroy the edit.
 *
 * ## Not implemented, deliberately
 *
 * **roll** (dragging a seam so the two clips either side trade frames) and
 * **slide** (moving a clip between its neighbours while they absorb it) are
 * the other two edge gestures README gap 1 names. The 「10」 artboard has no
 * entry point for either — no seam handle, no modifier legend, nothing in the
 * toolbar — so building them would be building a control nobody can reach.
 * They stay recorded as gaps.
 */

import {
  clipEnd,
  clipsOnTrack,
  getClip,
  getTrack,
  linkGroup,
  patchClips,
  refuse,
  trimHeadroom,
  type Clip,
  type EditResult,
  type Timeline,
} from './timelineModel';
import { frameDuration } from './frameGrid';
import { TIME_EPSILON } from './timeScale';

/** Which edge the pointer has hold of. */
export type TrimEdge = 'in' | 'out';

export interface TrimOptions {
  /** Trim the A/V partners by the same delta. Default true. */
  linked?: boolean;
  /**
   * Shortest a clip may become, in frames. One is the floor the razor uses;
   * a caller wanting a longer minimum (a transition needs room) may raise it.
   */
  minFrames?: number;
}

export interface TrimResult extends EditResult {
  /** What actually happened, after the clamp. May be smaller than requested. */
  appliedDelta: number;
  /** How far the edge could still travel, once this trim is applied. */
  range: { min: number; max: number };
}

function trimRefusal(timeline: Timeline, reason: EditResult['reason']): TrimResult {
  return { ...refuse(timeline, reason ?? 'no-change'), appliedDelta: 0, range: { min: 0, max: 0 } };
}

/**
 * The clip immediately before / after `clip` on its own track, ignoring the
 * ones being trimmed with it.
 */
function neighbour(
  timeline: Timeline,
  clip: Clip,
  edge: TrimEdge,
  exclude: ReadonlySet<string>,
): Clip | undefined {
  const siblings = clipsOnTrack(timeline, clip.trackId).filter((other) => !exclude.has(other.id));
  if (edge === 'in') {
    return siblings.filter((other) => clipEnd(other) <= clip.start + TIME_EPSILON).at(-1);
  }
  return siblings.find((other) => other.start >= clipEnd(clip) - TIME_EPSILON);
}

/**
 * How far one clip's edge may travel, in timeline seconds. Positive is later
 * on the timeline for both edges — dragging right — so a trim in of +1 shortens
 * the clip and a trim out of +1 lengthens it. One sign convention for both
 * edges keeps the caller from having to flip a delta based on which handle the
 * pointer grabbed.
 */
export function trimRange(
  timeline: Timeline,
  clip: Clip,
  edge: TrimEdge,
  options: { minFrames?: number; exclude?: ReadonlySet<string> } = {},
): { min: number; max: number } {
  const { minFrames = 1, exclude = new Set([clip.id]) } = options;
  const minDuration = minFrames * frameDuration(timeline.fps);
  const headroom = trimHeadroom(clip);
  const adjacent = neighbour(timeline, clip, edge, exclude);

  if (edge === 'in') {
    // Left is limited by source head, t = 0 and the previous clip; right by
    // how much duration there is to give up.
    const toStart = -clip.start;
    const toNeighbour = adjacent === undefined ? Number.NEGATIVE_INFINITY : clipEnd(adjacent) - clip.start;
    return {
      min: Math.max(-headroom.in, toStart, toNeighbour),
      max: clip.duration - minDuration,
    };
  }
  const toNeighbour = adjacent === undefined ? Number.POSITIVE_INFINITY : adjacent.start - clipEnd(clip);
  return {
    min: -(clip.duration - minDuration),
    max: Math.min(headroom.out, toNeighbour),
  };
}

/** The intersection of a group's ranges — see the module comment. */
export function groupTrimRange(
  timeline: Timeline,
  clips: readonly Clip[],
  edge: TrimEdge,
  options: { minFrames?: number } = {},
): { min: number; max: number } {
  if (clips.length === 0) return { min: 0, max: 0 };
  const exclude = new Set(clips.map((clip) => clip.id));
  let min = Number.NEGATIVE_INFINITY;
  let max = Number.POSITIVE_INFINITY;
  for (const clip of clips) {
    const range = trimRange(timeline, clip, edge, { ...options, exclude });
    min = Math.max(min, range.min);
    max = Math.min(max, range.max);
  }
  // A group with no common room degrades to "no trim" rather than to an
  // inverted range that would drag the edge the wrong way — `groupSlipRange`
  // guards the same way, for the same reason.
  return min > max ? { min: 0, max: 0 } : { min, max };
}

/**
 * Moves one edge of a clip by `deltaSeconds`, positive being later on the
 * timeline for both edges.
 */
export function trimClip(
  timeline: Timeline,
  clipId: string,
  edge: TrimEdge,
  deltaSeconds: number,
  options: TrimOptions = {},
): TrimResult {
  const { linked = true, minFrames = 1 } = options;

  const clip = getClip(timeline, clipId);
  if (clip === undefined) return trimRefusal(timeline, 'unknown-clip');

  const group = linked ? linkGroup(timeline, clipId) : [clip];
  if (group.some((member) => getTrack(timeline, member.trackId)?.locked === true)) {
    return trimRefusal(timeline, 'track-locked');
  }

  const range = groupTrimRange(timeline, group, edge, { minFrames });
  const applied = Math.min(range.max, Math.max(range.min, deltaSeconds));

  if (Math.abs(applied) < TIME_EPSILON) {
    // Which way the user was pulling decides what to say. Shrinking with
    // nothing left to give is `too-short`; growing with nothing left to grow
    // into is `no-headroom` — the same word `slip` uses for a spent source.
    const shrinking = edge === 'in' ? deltaSeconds > 0 : deltaSeconds < 0;
    const reason = deltaSeconds === 0 ? 'no-change' : shrinking ? 'too-short' : 'no-headroom';
    return { ...refuse(timeline, reason), appliedDelta: 0, range };
  }

  const patches = new Map<string, Partial<Clip>>(
    group.map((member) => [
      member.id,
      edge === 'in'
        ? {
            start: member.start + applied,
            duration: member.duration - applied,
            // The source window's near edge follows the timeline edge, scaled
            // by speed: this is what keeps the frame under the cursor still.
            sourceIn: member.sourceIn + applied * member.speed,
          }
        : { duration: member.duration + applied },
    ]),
  );

  return {
    timeline: patchClips(timeline, patches),
    applied: true,
    appliedDelta: applied,
    range: { min: range.min - applied, max: range.max - applied },
  };
}

/**
 * The in / out timecodes an edge drag would produce, for the Inspector's 入点
 * / 出点 rows while the pointer is still down. Nothing is committed.
 */
export function trimPreview(
  timeline: Timeline,
  clip: Clip,
  edge: TrimEdge,
  deltaSeconds: number,
  options: TrimOptions = {},
): { start: number; duration: number; sourceIn: number; sourceOut: number; appliedDelta: number } {
  const group = (options.linked ?? true) ? linkGroup(timeline, clip.id) : [clip];
  const range = groupTrimRange(timeline, group, edge, {
    ...(options.minFrames === undefined ? {} : { minFrames: options.minFrames }),
  });
  const applied = Math.min(range.max, Math.max(range.min, deltaSeconds));
  const start = edge === 'in' ? clip.start + applied : clip.start;
  const duration = edge === 'in' ? clip.duration - applied : clip.duration + applied;
  const sourceIn = edge === 'in' ? clip.sourceIn + applied * clip.speed : clip.sourceIn;
  return { start, duration, sourceIn, sourceOut: sourceIn + duration * clip.speed, appliedDelta: applied };
}
