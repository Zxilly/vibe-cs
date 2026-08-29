import type { MediaAsset, TimelineClip } from '../../shared/desktop/dto';

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

export function moveRippleClip(
  clips: readonly TimelineClip[],
  clipId: string,
  proposedStart: number,
): TimelineClip[] {
  const moving = clips.find((clip) => clip.id === clipId);
  if (moving === undefined) return [...clips];
  const remaining = clips.filter((clip) => clip.id !== clipId);
  const proposedCentre = proposedStart + moving.placement.duration / 2;
  const before = remaining.findIndex(
    (clip) => proposedCentre < clip.placement.start + clip.placement.duration / 2,
  );
  const index = before < 0 ? remaining.length : before;
  const ordered = [...remaining];
  ordered.splice(index, 0, moving);
  const origin = Math.min(...clips.map((clip) => clip.placement.start));
  return reflow(ordered, origin);
}

export function trimRippleClip(
  clips: readonly TimelineClip[],
  replacement: TimelineClip,
): TimelineClip[] {
  const index = clips.findIndex((clip) => clip.id === replacement.id);
  if (index < 0) return [...clips];
  const next = [...clips];
  next[index] = replacement;
  return reflow(next);
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
  const sourceSplit = clip.placement.source_in + localTime * clip.placement.speed;
  const left: TimelineClip = {
    ...clip,
    placement: {
      ...clip.placement,
      duration: localTime,
      source_out: sourceSplit,
    },
  };
  const right: TimelineClip = {
    ...clip,
    id: rightClipId,
    name: `${clip.name} · B`,
    placement: {
      ...clip.placement,
      start: timelineTime,
      duration: clip.placement.duration - localTime,
      source_in: sourceSplit,
    },
  };
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

export function timelineClipFromMediaAsset(asset: MediaAsset, clipId: string): TimelineClip {
  const duration = asset.duration_seconds ?? 0;
  return {
    id: clipId,
    name: asset.name,
    capture_intent: null,
    material: { kind: 'asset', asset_id: asset.id, media_duration_seconds: duration },
    placement: {
      start: 0,
      duration,
      source_in: 0,
      source_out: duration,
      speed: 1,
      volume: 1,
      enabled: true,
    },
    transform: { x: 0, y: 0, scale_x: 1, scale_y: 1, rotation: 0, opacity: 1 },
    effects: [],
    transition_in: null,
    transition_out: null,
    text: null,
    metadata: { media_asset_id: asset.id },
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

function copiesAtTime(
  copied: readonly TimelineClip[],
  timelineTime: number,
  clipIds: readonly string[],
): TimelineClip[] {
  const copiedOrigin = copied[0]?.placement.start ?? 0;
  return copied.map((clip, index) => ({
    ...clip,
    id: clipIds[index]!,
    placement: {
      ...clip.placement,
      start: timelineTime + clip.placement.start - copiedOrigin,
    },
    group_id: null,
    link_group_id: null,
  }));
}

export function pasteRippleClipsAtTime(
  clips: readonly TimelineClip[],
  copied: readonly TimelineClip[],
  timelineTime: number,
  clipIds: readonly string[],
  splitTailId: string,
): TimelineClip[] {
  if (copied.length === 0) return [...clips];
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
  next.splice(insertionIndex, 0, ...copiesAtTime(copied, timelineTime, clipIds));
  const origin = Math.min(clips[0]?.placement.start ?? timelineTime, timelineTime);
  return reflow(next, origin);
}

export function pasteFreePositionedClipsAtTime(
  clips: readonly TimelineClip[],
  copied: readonly TimelineClip[],
  timelineTime: number,
  clipIds: readonly string[],
): TimelineClip[] {
  return [...clips, ...copiesAtTime(copied, timelineTime, clipIds)]
    .sort((left, right) => left.placement.start - right.placement.start);
}
