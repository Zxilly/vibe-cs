import type { TimelineClip } from '../../shared/desktop/dto';

export interface TimelineGap {
  readonly start: number;
  readonly end: number;
  readonly duration: number;
}

export function timelineGaps(clips: readonly TimelineClip[]): TimelineGap[] {
  const ordered = [...clips]
    .filter((clip) => clip.placement.enabled)
    .sort((left, right) => left.placement.start - right.placement.start);
  const gaps: TimelineGap[] = [];
  let cursor = 0;
  for (const clip of ordered) {
    if (clip.placement.start > cursor + 1e-6) {
      gaps.push({ start: cursor, end: clip.placement.start, duration: clip.placement.start - cursor });
    }
    cursor = Math.max(cursor, clip.placement.start + clip.placement.duration);
  }
  return gaps;
}

export function closeTimelineGap(clips: readonly TimelineClip[], gap: TimelineGap): TimelineClip[] {
  return clips.map((clip) => clip.placement.start + 1e-6 < gap.end
    ? clip
    : { ...clip, placement: { ...clip.placement, start: clip.placement.start - gap.duration } });
}

export function closeAllTimelineGaps(clips: readonly TimelineClip[]): TimelineClip[] {
  const ordered = [...clips].sort((left, right) => left.placement.start - right.placement.start);
  let cursor = 0;
  return ordered.map((clip) => {
    if (!clip.placement.enabled) return clip;
    const replacement = { ...clip, placement: { ...clip.placement, start: cursor } };
    cursor += clip.placement.duration;
    return replacement;
  });
}
