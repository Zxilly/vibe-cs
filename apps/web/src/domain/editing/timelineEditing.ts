import type { TimelineClip } from '../../shared/desktop/dto';

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
  return reflow(clips.filter((clip) => clip.id !== clipId));
}
