/*
 * Design system, layer 1 of 3 — multi-track timeline prototype (spec §0.5).
 *
 * 拖拽 — 「片段在轨内平移、跨轨移动；越界与重叠的处理规则要明确并测到」.
 *
 * The rules, stated once here so the UI never has to invent one:
 *
 *   越界（左）  A move that would put any member of the link group before t = 0
 *              is clamped to 0 by default, not refused: the group translates
 *              as far as it can and stops. `clampToOrigin: false` refuses
 *              instead, which is what a keyboard nudge wants so it can beep.
 *   越界（右）  There is no right bound. The sequence is as long as its last
 *              clip; dragging past the end extends it.
 *   跨轨       Only onto a track of the same kind. A video clip cannot land on
 *              A2, and the refusal is `track-kind-mismatch` rather than a
 *              silent snap-back, so the drag can paint the lane red while the
 *              pointer is still down.
 *   链接       Partners keep their own track and move by the same delta. This
 *              is the standard NLE behaviour and the only one that survives
 *              「音视频可链接」: an A/V pair dragged onto V2 must not drag the
 *              audio onto V1.
 *   重叠       Two policies, both implemented, `reject` the default:
 *              · reject    nothing moves, reason `overlap`
 *              · overwrite the moved clip wins; what it lands on is trimmed,
 *                          split in two, or removed outright
 *
 * `planMove` answers "where would this land" without producing a document, so
 * the drag preview can run it on every pointermove for free; `moveClip` commits.
 */

import {
  clipEnd,
  clipIdSet,
  findOverlapping,
  getClip,
  getTrack,
  linkGroup,
  mintId,
  refuse,
  withClips,
  type Clip,
  type EditRefusal,
  type EditResult,
  type Timeline,
} from './timelineModel';
import { TIME_EPSILON } from './timeScale';

export type OverlapPolicy = 'reject' | 'overwrite';

export interface Placement {
  clipId: string;
  trackId: string;
  start: number;
  duration: number;
}

export interface MovePlan {
  /** The time delta actually available, after clamping at t = 0. */
  deltaSeconds: number;
  /** Where every member of the link group would end up. */
  placements: Placement[];
  /** Clips that would be trimmed or removed under `overwrite`. */
  collisions: Clip[];
  /** Set when the move cannot happen at all. */
  refusal?: EditRefusal;
}

export interface MoveOptions {
  /** Destination track for the dragged clip. Omitted: it stays on its own. */
  toTrackId?: string;
  overlap?: OverlapPolicy;
  /** Clamp at t = 0 rather than refusing. Default true. */
  clampToOrigin?: boolean;
}

export function planMove(
  timeline: Timeline,
  clipId: string,
  toStart: number,
  options: MoveOptions = {},
): MovePlan {
  const { toTrackId, overlap = 'reject', clampToOrigin = true } = options;
  const empty: MovePlan = { deltaSeconds: 0, placements: [], collisions: [] };

  const clip = getClip(timeline, clipId);
  if (clip === undefined) return { ...empty, refusal: 'unknown-clip' };

  const sourceTrack = getTrack(timeline, clip.trackId);
  const destinationTrack = getTrack(timeline, toTrackId ?? clip.trackId);
  if (sourceTrack === undefined || destinationTrack === undefined) return { ...empty, refusal: 'unknown-track' };
  if (destinationTrack.kind !== sourceTrack.kind) return { ...empty, refusal: 'track-kind-mismatch' };

  const group = linkGroup(timeline, clipId);
  if (group.some((member) => getTrack(timeline, member.trackId)?.locked === true)) {
    return { ...empty, refusal: 'track-locked' };
  }
  if (destinationTrack.locked === true) return { ...empty, refusal: 'track-locked' };

  let delta = toStart - clip.start;
  const earliest = Math.min(...group.map((member) => member.start));
  if (earliest + delta < -TIME_EPSILON) {
    if (!clampToOrigin) return { ...empty, refusal: 'out-of-bounds' };
    delta = -earliest;
  }

  const placements: Placement[] = group.map((member) => ({
    clipId: member.id,
    // Only the clip under the pointer changes lane; partners keep theirs.
    trackId: member.id === clip.id ? destinationTrack.id : member.trackId,
    start: member.start + delta,
    duration: member.duration,
  }));

  const groupIds = new Set(group.map((member) => member.id));
  const collisions: Clip[] = [];
  for (const placement of placements) {
    for (const victim of findOverlapping(
      timeline,
      placement.trackId,
      placement.start,
      placement.start + placement.duration,
      groupIds,
    )) {
      if (!collisions.includes(victim)) collisions.push(victim);
    }
  }

  if (collisions.length > 0) {
    if (overlap === 'reject') return { deltaSeconds: delta, placements, collisions, refusal: 'overlap' };
    if (collisions.some((victim) => getTrack(timeline, victim.trackId)?.locked === true)) {
      return { deltaSeconds: delta, placements, collisions, refusal: 'track-locked' };
    }
  }

  if (Math.abs(delta) < TIME_EPSILON && destinationTrack.id === clip.trackId) {
    return { deltaSeconds: 0, placements, collisions, refusal: 'no-change' };
  }

  return { deltaSeconds: delta, placements, collisions };
}

export interface MoveResult extends EditResult {
  deltaSeconds: number;
  /** Clips the `overwrite` policy deleted outright. */
  removedIds: string[];
  /** Ids minted for the tail of a clip that was split by an overwrite. */
  createdIds: string[];
}

export function moveClip(
  timeline: Timeline,
  clipId: string,
  toStart: number,
  options: MoveOptions = {},
): MoveResult {
  const plan = planMove(timeline, clipId, toStart, options);
  if (plan.refusal !== undefined) {
    return { ...refuse(timeline, plan.refusal), deltaSeconds: plan.deltaSeconds, removedIds: [], createdIds: [] };
  }

  const placementById = new Map(plan.placements.map((placement) => [placement.clipId, placement]));
  let clips: Clip[] = timeline.clips.map((clip) => {
    const placement = placementById.get(clip.id);
    return placement === undefined ? clip : { ...clip, trackId: placement.trackId, start: placement.start };
  });

  const removedIds: string[] = [];
  const createdIds: string[] = [];

  if (plan.collisions.length > 0) {
    const taken = clipIdSet(timeline);
    const groupIds = new Set(plan.placements.map((placement) => placement.clipId));
    for (const placement of plan.placements) {
      const carved = carveRegion(clips, placement, groupIds, taken);
      clips = carved.clips;
      removedIds.push(...carved.removedIds);
      createdIds.push(...carved.createdIds);
    }
  }

  return { timeline: withClips(timeline, clips), applied: true, deltaSeconds: plan.deltaSeconds, removedIds, createdIds };
}

/** `moveClip` addressed by delta — what a keyboard nudge and a wheel scrub want. */
export function moveClipBy(
  timeline: Timeline,
  clipId: string,
  deltaSeconds: number,
  options: MoveOptions = {},
): MoveResult {
  const clip = getClip(timeline, clipId);
  if (clip === undefined) {
    return { ...refuse(timeline, 'unknown-clip'), deltaSeconds: 0, removedIds: [], createdIds: [] };
  }
  return moveClip(timeline, clipId, clip.start + deltaSeconds, options);
}

/**
 * Removes `[placement.start, placement.start + duration)` from every clip on
 * that track that is not part of the moving group: full cover deletes, one-side
 * overlap trims, and a clip that straddles the region is split in two.
 *
 * A trim on the *left* keeps `sourceIn`; a trim on the *right* has to advance
 * it by exactly the amount removed, or the surviving footage would jump. Same
 * arithmetic as the razor, and for the same reason.
 */
function carveRegion(
  clips: readonly Clip[],
  placement: Placement,
  groupIds: ReadonlySet<string>,
  taken: Set<string>,
): { clips: Clip[]; removedIds: string[]; createdIds: string[] } {
  const regionStart = placement.start;
  const regionEnd = placement.start + placement.duration;
  const kept: Clip[] = [];
  const removedIds: string[] = [];
  const createdIds: string[] = [];

  for (const clip of clips) {
    const overlaps =
      clip.trackId === placement.trackId &&
      !groupIds.has(clip.id) &&
      clip.start < regionEnd - TIME_EPSILON &&
      clipEnd(clip) > regionStart + TIME_EPSILON;

    if (!overlaps) {
      kept.push(clip);
      continue;
    }

    const coveredLeft = clip.start >= regionStart - TIME_EPSILON;
    const coveredRight = clipEnd(clip) <= regionEnd + TIME_EPSILON;

    if (coveredLeft && coveredRight) {
      removedIds.push(clip.id);
      continue;
    }

    if (!coveredLeft) {
      kept.push({ ...clip, duration: regionStart - clip.start });
    }

    if (!coveredRight) {
      const removedHead = regionEnd - clip.start;
      const tail: Clip = {
        ...clip,
        start: regionEnd,
        duration: clipEnd(clip) - regionEnd,
        sourceIn: clip.sourceIn + removedHead,
      };
      if (coveredLeft) {
        // Only the right side survives: keep the clip's identity.
        kept.push(tail);
      } else {
        const id = mintId(taken, clip.id);
        taken.add(id);
        createdIds.push(id);
        kept.push({ ...tail, id });
      }
    }
  }

  return { clips: kept, removedIds, createdIds };
}
