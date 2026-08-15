/*
 * Design system, layer 1 of 3 — multi-track timeline prototype (spec §0.5).
 *
 * 波纹删除 — 「删除片段后其右侧片段整体左移，链接的音视频一起动」.
 *
 * Three scopes, because the one the artboard's toolbar button means is not the
 * only one an editor needs and picking silently would be a lie:
 *
 *   track   only the clip's own lane closes up. The other lanes keep their
 *           timing, which is what you want when V2 is a name plate that must
 *           stay over its speaker.
 *   linked  the clip's lane and the lanes of its A/V partners, each by the
 *           length of the clip that left *that* lane. The default, and the
 *           one 「链接的音视频一起动」 names.
 *   all     every lane shifts by the same gap. Classic sequence ripple; it is
 *           the only scope that keeps unrelated lanes in sync, and the only
 *           one that can drag an untouched lane out from under its cut.
 *
 * Markers are left where they are by default. A marker names a moment in the
 * *match* (「1v3 CLUTCH」), not a moment in the edit, so closing a gap does not
 * move it. `rippleMarkers` flips that for callers who disagree.
 *
 * The playhead never moves. It is where the user is looking.
 */

import {
  clipEnd,
  getClip,
  getTrack,
  linkGroup,
  refuse,
  withClips,
  withMarkers,
  type Clip,
  type EditResult,
  type Marker,
  type Timeline,
} from './timelineModel';
import { TIME_EPSILON } from './timeScale';

export type RippleScope = 'track' | 'linked' | 'all';

export interface RippleOptions {
  scope?: RippleScope;
  /** Shift markers at or after the cut too. Default false. */
  rippleMarkers?: boolean;
  /** Delete the A/V partners as well. Default true. */
  linked?: boolean;
}

export interface RippleResult extends EditResult {
  removedIds: string[];
  shiftedIds: string[];
  /** How much each affected lane closed up, keyed by track. */
  gapByTrack: Record<string, number>;
}

function rippleRefusal(timeline: Timeline, reason: EditResult['reason']): RippleResult {
  return { ...refuse(timeline, reason ?? 'no-change'), removedIds: [], shiftedIds: [], gapByTrack: {} };
}

/**
 * Deletes a clip and closes the gap behind it.
 *
 * A clip qualifies for the shift when it starts at or after the removed clip's
 * start *on its own lane* — `>=`, so a clip butted directly against the removed
 * one moves, and a clip that merely ends there does not.
 */
export function rippleDelete(timeline: Timeline, clipId: string, options: RippleOptions = {}): RippleResult {
  const { scope = 'linked', rippleMarkers = false, linked = true } = options;

  const clip = getClip(timeline, clipId);
  if (clip === undefined) return rippleRefusal(timeline, 'unknown-clip');

  const removed = linked ? linkGroup(timeline, clipId) : [clip];
  if (removed.some((member) => getTrack(timeline, member.trackId)?.locked === true)) {
    return rippleRefusal(timeline, 'track-locked');
  }

  const removedIds = new Set(removed.map((member) => member.id));

  // Gap per lane. `all` uses the primary clip's length everywhere, so lanes
  // that lost nothing still close by the same amount and stay in sync.
  const gapByTrack: Record<string, number> = {};
  if (scope === 'all') {
    for (const track of timeline.tracks) gapByTrack[track.id] = clip.duration;
  } else {
    const lanes = scope === 'track' ? [clip] : removed;
    for (const member of lanes) {
      gapByTrack[member.trackId] = Math.max(gapByTrack[member.trackId] ?? 0, member.duration);
    }
  }

  const cutStart = scope === 'all' ? clip.start : undefined;
  const startByTrack = new Map<string, number>();
  for (const member of removed) {
    const existing = startByTrack.get(member.trackId);
    startByTrack.set(member.trackId, existing === undefined ? member.start : Math.min(existing, member.start));
  }

  const shiftedIds: string[] = [];
  const clips: Clip[] = [];
  for (const candidate of timeline.clips) {
    if (removedIds.has(candidate.id)) continue;

    const gap = gapByTrack[candidate.trackId];
    if (gap === undefined || gap <= TIME_EPSILON) {
      clips.push(candidate);
      continue;
    }
    if (getTrack(timeline, candidate.trackId)?.locked === true) {
      clips.push(candidate);
      continue;
    }

    const from = cutStart ?? startByTrack.get(candidate.trackId) ?? clip.start;
    if (candidate.start < from - TIME_EPSILON) {
      clips.push(candidate);
      continue;
    }

    shiftedIds.push(candidate.id);
    clips.push({ ...candidate, start: Math.max(0, candidate.start - gap) });
  }

  let next = withClips(timeline, clips);

  if (rippleMarkers) {
    const from = cutStart ?? clip.start;
    const gap = gapByTrack[clip.trackId] ?? clip.duration;
    const markers: Marker[] = timeline.markers.map((marker) =>
      marker.time >= from - TIME_EPSILON ? { ...marker, time: Math.max(0, marker.time - gap) } : marker,
    );
    next = withMarkers(next, markers);
  }

  return {
    timeline: next,
    applied: true,
    removedIds: [...removedIds],
    shiftedIds,
    gapByTrack,
  };
}

/**
 * Delete without closing the gap — the 「删除」 half of the pair. Kept next to
 * ripple so the difference between the two is one call site, not one branch
 * buried in a component.
 */
export function liftDelete(timeline: Timeline, clipId: string, options: { linked?: boolean } = {}): RippleResult {
  const { linked = true } = options;
  const clip = getClip(timeline, clipId);
  if (clip === undefined) return rippleRefusal(timeline, 'unknown-clip');

  const removed = linked ? linkGroup(timeline, clipId) : [clip];
  if (removed.some((member) => getTrack(timeline, member.trackId)?.locked === true)) {
    return rippleRefusal(timeline, 'track-locked');
  }

  const removedIds = new Set(removed.map((member) => member.id));
  return {
    timeline: withClips(
      timeline,
      timeline.clips.filter((candidate) => !removedIds.has(candidate.id)),
    ),
    applied: true,
    removedIds: [...removedIds],
    shiftedIds: [],
    gapByTrack: {},
  };
}

/**
 * The gap a lane would close — what a confirmation string reads
 * (「删除后 V1 上其后的 3 个片段左移 28.0 秒」) without performing the edit.
 */
export function rippleImpact(
  timeline: Timeline,
  clipId: string,
  options: RippleOptions = {},
): { removed: number; shifted: number; gapSeconds: number } {
  const result = rippleDelete(timeline, clipId, options);
  const clip = getClip(timeline, clipId);
  return {
    removed: result.removedIds.length,
    shifted: result.shiftedIds.length,
    gapSeconds: clip === undefined ? 0 : clip.duration,
  };
}

/** End of the last clip on one lane — used to prove a ripple closed the gap. */
export function trackDuration(timeline: Timeline, trackId: string): number {
  return timeline.clips.reduce((longest, clip) => (clip.trackId === trackId ? Math.max(longest, clipEnd(clip)) : longest), 0);
}
