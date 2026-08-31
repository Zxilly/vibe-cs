import type { MediaAsset, TimelineClip } from '../../shared/desktop/dto';
import { mediaAssetEditDuration } from './mediaDrag';
import {
  clipMediaDuration,
  clipSourceTimeAtLocalTime,
  constrainClipGroupTrimDelta,
  sliceClipSpeedSegments,
  trimTimelineClip,
} from './timelineInteraction';

const TIME_EPSILON = 1e-6;

function reflow(clips: readonly TimelineClip[], origin = clips[0]?.placement.start ?? 0): TimelineClip[] {
  let cursor = origin;
  return clips.map((clip) => {
    const next = {
      ...clip,
      placement: {
        ...clip.placement,
        start: cursor,
      },
    };
    cursor += clip.placement.duration;
    return next;
  });
}

function sliceTimelineClip(
  clip: TimelineClip,
  localStart: number,
  localEnd: number,
  id = clip.id,
  name = clip.name,
): TimelineClip {
  const sourceIn = clipSourceTimeAtLocalTime(clip, localStart);
  const sourceOut = clipSourceTimeAtLocalTime(clip, localEnd);
  const duration = localEnd - localStart;
  return {
    ...clip,
    id,
    name,
    transitions: {
      video_in: localStart <= TIME_EPSILON ? clip.transitions.video_in : null,
      video_out: localEnd >= clip.placement.duration - TIME_EPSILON ? clip.transitions.video_out : null,
      audio_in: localStart <= TIME_EPSILON ? clip.transitions.audio_in : null,
      audio_out: localEnd >= clip.placement.duration - TIME_EPSILON ? clip.transitions.audio_out : null,
    },
    placement: {
      ...clip.placement,
      start: clip.placement.start + localStart,
      duration,
      source_in: sourceIn,
      source_out: sourceOut,
      speed: (sourceOut - sourceIn) / duration,
    },
    keyframes: clip.keyframes
      .filter((keyframe) => keyframe.time >= localStart - TIME_EPSILON && keyframe.time <= localEnd + TIME_EPSILON)
      .map((keyframe) => ({ ...keyframe, time: keyframe.time - localStart })),
    speed_segments: sliceClipSpeedSegments(clip, localStart, localEnd),
  };
}

export function moveRippleClip(
  clips: readonly TimelineClip[],
  clipId: string,
  proposedStart: number,
): TimelineClip[] {
  const moving = clips.find((clip) => clip.id === clipId);
  if (moving === undefined) return [...clips];
  const remaining = clips.filter((clip) => clip.id !== clipId);
  const insertionProbe = proposedStart < moving.placement.start
    ? proposedStart
    : proposedStart + moving.placement.duration;
  const before = remaining.findIndex(
    (clip) => insertionProbe < clip.placement.start + clip.placement.duration / 2,
  );
  const index = before < 0 ? remaining.length : before;
  const ordered = [...remaining];
  ordered.splice(index, 0, moving);
  const origin = Math.min(...clips.map((clip) => clip.placement.start));
  return reflow(ordered, origin);
}

export function moveRippleClipGroup(
  clips: readonly TimelineClip[],
  clipIds: ReadonlySet<string>,
  anchorClipId: string,
  proposedAnchorStart: number,
): TimelineClip[] {
  const moving = clips.filter((clip) => clipIds.has(clip.id));
  const anchorIndex = moving.findIndex((clip) => clip.id === anchorClipId);
  if (moving.length === 0 || anchorIndex < 0) return [...clips];
  const anchorOffset = moving
    .slice(0, anchorIndex)
    .reduce((total, clip) => total + clip.placement.duration, 0);
  const groupDuration = moving.reduce((total, clip) => total + clip.placement.duration, 0);
  const currentGroupStart = moving[0]?.placement.start ?? 0;
  const proposedGroupStart = proposedAnchorStart - anchorOffset;
  const insertionProbe = proposedGroupStart < currentGroupStart
    ? proposedGroupStart
    : proposedGroupStart + groupDuration;
  const remaining = clips.filter((clip) => !clipIds.has(clip.id));
  const before = remaining.findIndex(
    (clip) => insertionProbe < clip.placement.start + clip.placement.duration / 2,
  );
  const index = before < 0 ? remaining.length : before;
  const ordered = [...remaining];
  ordered.splice(index, 0, ...moving);
  return reflow(ordered, clips[0]?.placement.start ?? 0);
}

export function moveFreeClipGroup(
  clips: readonly TimelineClip[],
  clipIds: ReadonlySet<string>,
  anchorClipId: string,
  proposedAnchorStart: number,
  fps: number,
): TimelineClip[] {
  const anchor = clips.find((clip) => clip.id === anchorClipId);
  const moving = clips.filter((clip) => clipIds.has(clip.id));
  if (anchor === undefined || moving.length === 0) return [...clips];
  const snappedAnchorStart = Math.round(Math.max(0, proposedAnchorStart) * Math.max(1, fps)) / Math.max(1, fps);
  const requestedDelta = snappedAnchorStart - anchor.placement.start;
  const minimumStart = Math.min(...moving.map((clip) => clip.placement.start));
  const delta = Math.max(requestedDelta, -minimumStart);
  return clips.map((clip) => clipIds.has(clip.id)
    ? { ...clip, placement: { ...clip.placement, start: clip.placement.start + delta } }
    : clip).sort((left, right) => left.placement.start - right.placement.start);
}

export function trimRippleClip(
  clips: readonly TimelineClip[],
  replacement: TimelineClip,
): TimelineClip[] {
  const index = clips.findIndex((clip) => clip.id === replacement.id);
  if (index < 0) return [...clips];
  const next = [...clips];
  next[index] = replacement;
  return reflow(next, clips[0]?.placement.start ?? 0);
}

function trimClipGroup(
  clips: readonly TimelineClip[],
  clipIds: ReadonlySet<string>,
  edge: 'start' | 'end',
  requestedDelta: number,
  fps: number,
  ripple: boolean,
): TimelineClip[] {
  const selected = clips.filter((clip) => clipIds.has(clip.id));
  if (selected.length === 0) return [...clips];
  const delta = constrainClipGroupTrimDelta(selected, edge, requestedDelta, fps);
  const next = clips.map((clip) => {
    if (!clipIds.has(clip.id)) return clip;
    const timelineTime = edge === 'start'
      ? clip.placement.start + delta
      : clip.placement.start + clip.placement.duration + delta;
    return trimTimelineClip(clip, edge, timelineTime, fps, clipMediaDuration(clip));
  });
  return ripple ? reflow(next, clips[0]?.placement.start ?? 0) : next;
}

export function trimRippleClipGroup(
  clips: readonly TimelineClip[],
  clipIds: ReadonlySet<string>,
  edge: 'start' | 'end',
  requestedDelta: number,
  fps: number,
): TimelineClip[] {
  return trimClipGroup(clips, clipIds, edge, requestedDelta, fps, true);
}

export function trimFreeClipGroup(
  clips: readonly TimelineClip[],
  clipIds: ReadonlySet<string>,
  edge: 'start' | 'end',
  requestedDelta: number,
  fps: number,
): TimelineClip[] {
  return trimClipGroup(clips, clipIds, edge, requestedDelta, fps, false);
}

export function splitRippleClip(
  clips: readonly TimelineClip[],
  clipId: string,
  timelineTime: number,
  rightClipId: string,
): TimelineClip[] {
  const index = clips.findIndex((clip) => clip.id === clipId);
  const clip = clips[index];
  if (clip === undefined) return [...clips];
  const localTime = timelineTime - clip.placement.start;
  if (localTime <= TIME_EPSILON || localTime >= clip.placement.duration - TIME_EPSILON) {
    return [...clips];
  }
  const left = sliceTimelineClip(clip, 0, localTime);
  const right = sliceTimelineClip(clip, localTime, clip.placement.duration, rightClipId, `${clip.name} · B`);
  const next = [...clips];
  next.splice(index, 1, left, right);
  return reflow(next);
}

export function deleteRippleClip(
  clips: readonly TimelineClip[],
  clipId: string,
): TimelineClip[] {
  return deleteRippleClips(clips, new Set([clipId]));
}

export function deleteRippleClips(
  clips: readonly TimelineClip[],
  clipIds: ReadonlySet<string>,
): TimelineClip[] {
  return reflow(
    clips.filter((clip) => !clipIds.has(clip.id)),
    clips[0]?.placement.start ?? 0,
  );
}

export function timelineClipFromMediaAsset(
  asset: MediaAsset,
  clipId: string,
  sourceRange?: { readonly sourceIn: number; readonly sourceOut: number },
): TimelineClip {
  const mediaDuration = mediaAssetEditDuration(asset) ?? 0;
  const sourceIn = Math.min(mediaDuration, Math.max(0, sourceRange?.sourceIn ?? 0));
  const sourceOut = Math.min(mediaDuration, Math.max(sourceIn, sourceRange?.sourceOut ?? mediaDuration));
  const duration = sourceOut - sourceIn;
  return {
    id: clipId,
    name: asset.name,
    capture_intent: null,
    material: { kind: 'asset', asset_id: asset.id, media_duration_seconds: mediaDuration },
    placement: {
      start: 0,
      duration,
      source_in: sourceIn,
      source_out: sourceOut,
      speed: 1,
      volume: 1,
      enabled: true,
    },
    transform: { x: 0, y: 0, scale_x: 1, scale_y: 1, rotation: 0, opacity: 1 },
    effects: [],
    transitions: { video_in: null, video_out: null, audio_in: null, audio_out: null },
    text: null,
    metadata: { media_asset_id: asset.id, media_kind: asset.kind },
    group_id: null,
    link_group_id: null,
    keyframes: [],
    speed_segments: [],
  };
}

export function insertRippleClipAtTime(
  clips: readonly TimelineClip[],
  inserted: TimelineClip,
  timelineTime: number,
  splitTailId: string,
): TimelineClip[] {
  const containingIndex = clips.findIndex((clip) => timelineTime > clip.placement.start + TIME_EPSILON
    && timelineTime < clip.placement.start + clip.placement.duration - TIME_EPSILON);
  let next = [...clips];
  let insertionIndex: number;
  if (containingIndex >= 0) {
    const containing = clips[containingIndex]!;
    next = splitRippleClip(clips, containing.id, timelineTime, splitTailId);
    insertionIndex = containingIndex + 1;
  } else {
    const boundaryIndex = clips.findIndex((clip) => clip.placement.start >= timelineTime - TIME_EPSILON);
    insertionIndex = boundaryIndex < 0 ? clips.length : boundaryIndex;
  }
  next.splice(insertionIndex, 0, {
    ...inserted,
    placement: { ...inserted.placement, start: timelineTime },
  });
  const origin = Math.min(clips[0]?.placement.start ?? timelineTime, timelineTime);
  return reflow(next, origin);
}

export function placeFreeClipAtTime(
  clips: readonly TimelineClip[],
  inserted: TimelineClip,
  timelineTime: number,
): TimelineClip[] {
  return [...clips, {
    ...inserted,
    placement: { ...inserted.placement, start: timelineTime },
  }].sort((left, right) => left.placement.start - right.placement.start);
}

export function overwriteClipsAtTime(
  clips: readonly TimelineClip[],
  inserted: TimelineClip,
  timelineTime: number,
  rightClipId: string,
): TimelineClip[] {
  const overwriteEnd = timelineTime + inserted.placement.duration;
  const next: TimelineClip[] = [];
  for (const clip of clips) {
    const clipStart = clip.placement.start;
    const clipEnd = clipStart + clip.placement.duration;
    if (clipEnd <= timelineTime + TIME_EPSILON || clipStart >= overwriteEnd - TIME_EPSILON) {
      next.push(clip);
      continue;
    }
    const leftDuration = Math.max(0, timelineTime - clipStart);
    const rightDuration = Math.max(0, clipEnd - overwriteEnd);
    if (leftDuration > TIME_EPSILON) {
      next.push(sliceTimelineClip(clip, 0, leftDuration));
    }
    if (rightDuration > TIME_EPSILON) {
      next.push(sliceTimelineClip(
        clip,
        clip.placement.duration - rightDuration,
        clip.placement.duration,
        leftDuration > TIME_EPSILON ? rightClipId : clip.id,
        leftDuration > TIME_EPSILON ? `${clip.name} · B` : clip.name,
      ));
    }
  }
  next.push({
    ...inserted,
    placement: { ...inserted.placement, start: timelineTime },
  });
  return next.sort((left, right) => left.placement.start - right.placement.start);
}

export function timelineClipsInRange(
  clips: readonly TimelineClip[],
  rangeStart: number,
  rangeEnd: number,
): TimelineClip[] {
  const from = Math.min(rangeStart, rangeEnd);
  const to = Math.max(rangeStart, rangeEnd);
  if (to - from <= TIME_EPSILON) return [];
  return clips.flatMap((clip) => {
    const clipStart = clip.placement.start;
    const localStart = Math.max(0, from - clipStart);
    const localEnd = Math.min(clip.placement.duration, to - clipStart);
    return localEnd - localStart <= TIME_EPSILON
      ? []
      : [sliceTimelineClip(clip, localStart, localEnd)];
  });
}

function cutTimelineRange(
  clips: readonly TimelineClip[],
  rangeStart: number,
  rangeEnd: number,
  rightClipId: string,
): TimelineClip[] {
  const from = Math.min(rangeStart, rangeEnd);
  const to = Math.max(rangeStart, rangeEnd);
  if (to - from <= TIME_EPSILON) return [...clips];
  const next: TimelineClip[] = [];
  for (const clip of clips) {
    const clipStart = clip.placement.start;
    const clipEnd = clipStart + clip.placement.duration;
    if (clipEnd <= from + TIME_EPSILON || clipStart >= to - TIME_EPSILON) {
      next.push(clip);
      continue;
    }
    const leftDuration = Math.max(0, from - clipStart);
    const rightDuration = Math.max(0, clipEnd - to);
    if (leftDuration > TIME_EPSILON) {
      next.push(sliceTimelineClip(clip, 0, leftDuration));
    }
    if (rightDuration > TIME_EPSILON) {
      next.push(sliceTimelineClip(
        clip,
        clip.placement.duration - rightDuration,
        clip.placement.duration,
        leftDuration > TIME_EPSILON ? rightClipId : clip.id,
        leftDuration > TIME_EPSILON ? `${clip.name} · B` : clip.name,
      ));
    }
  }
  return next.sort((left, right) => left.placement.start - right.placement.start);
}

export function liftTimelineRange(
  clips: readonly TimelineClip[],
  rangeStart: number,
  rangeEnd: number,
  rightClipId: string,
): TimelineClip[] {
  return cutTimelineRange(clips, rangeStart, rangeEnd, rightClipId);
}

export function extractTimelineRange(
  clips: readonly TimelineClip[],
  rangeStart: number,
  rangeEnd: number,
  rightClipId: string,
): TimelineClip[] {
  const from = Math.min(rangeStart, rangeEnd);
  const to = Math.max(rangeStart, rangeEnd);
  const duration = to - from;
  if (duration <= TIME_EPSILON) return [...clips];
  return cutTimelineRange(clips, from, to, rightClipId).map((clip) => (
    clip.placement.start < to - TIME_EPSILON
      ? clip
      : { ...clip, placement: { ...clip.placement, start: clip.placement.start - duration } }
  ));
}
