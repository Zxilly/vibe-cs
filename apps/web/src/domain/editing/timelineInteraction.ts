import type { TimelineClip } from '../../shared/desktop/dto';

const MINIMUM_CLIP_FRAMES = 1;

export interface TimelineSnapResult {
  readonly anchorTime: number;
  readonly snapTime: number | null;
}

export function snapTimeToFrame(seconds: number, fps: number): number {
  const safeFps = Math.max(1, fps);
  return Math.round(Math.max(0, seconds) * safeFps) / safeFps;
}

export function resolveTimelineSnap(
  anchorTime: number,
  anchorOffsets: readonly number[],
  candidates: readonly number[],
  thresholdSeconds: number,
): TimelineSnapResult {
  let closestDistance = Number.POSITIVE_INFINITY;
  let adjustment = 0;
  let snapTime: number | null = null;
  for (const offset of anchorOffsets) {
    const target = anchorTime + offset;
    for (const candidate of candidates) {
      const distance = Math.abs(candidate - target);
      if (distance <= thresholdSeconds && distance < closestDistance) {
        closestDistance = distance;
        adjustment = candidate - target;
        snapTime = candidate;
      }
    }
  }
  return { anchorTime: Math.max(0, anchorTime + adjustment), snapTime };
}

export function moveTimelineClip(clip: TimelineClip, start: number, fps: number): TimelineClip {
  return {
    ...clip,
    placement: {
      ...clip.placement,
      start: snapTimeToFrame(start, fps),
    },
  };
}

export function trimTimelineClip(
  clip: TimelineClip,
  edge: 'start' | 'end',
  timelineSeconds: number,
  fps: number,
  mediaDurationSeconds: number | null,
): TimelineClip {
  const frame = 1 / Math.max(1, fps);
  const minimumDuration = MINIMUM_CLIP_FRAMES * frame;
  const placement = clip.placement;

  if (edge === 'start') {
    const maximumStart = placement.start + placement.duration - minimumDuration;
    const nextStart = snapTimeToFrame(Math.min(maximumStart, Math.max(0, timelineSeconds)), fps);
    const timelineDelta = nextStart - placement.start;
    const nextSourceIn = Math.min(
      placement.source_out - minimumDuration * placement.speed,
      placement.source_in + timelineDelta * placement.speed,
    );
    const nextDuration = (placement.source_out - nextSourceIn) / placement.speed;
    return {
      ...clip,
      placement: {
        ...placement,
        start: nextStart,
        duration: nextDuration,
        source_in: nextSourceIn,
      },
    };
  }

  const requestedDuration = Math.max(minimumDuration, timelineSeconds - placement.start);
  const maximumSourceOut = mediaDurationSeconds ?? Number.POSITIVE_INFINITY;
  const nextSourceOut = Math.min(
    maximumSourceOut,
    placement.source_in + requestedDuration * placement.speed,
  );
  const nextDuration = Math.max(minimumDuration, (nextSourceOut - placement.source_in) / placement.speed);
  return {
    ...clip,
    placement: {
      ...placement,
      duration: snapTimeToFrame(nextDuration, fps),
      source_out: nextSourceOut,
    },
  };
}

export function clipMediaDuration(clip: TimelineClip): number | null {
  return clip.material.kind === 'planned' ? null : clip.material.media_duration_seconds;
}
