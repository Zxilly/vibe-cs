import type { TimelineClip } from '../../shared/desktop/dto';

const MINIMUM_CLIP_FRAMES = 1;
export const DEFAULT_CLIP_FADE_SECONDS = 0.35;
export const MIN_CLIP_FADE_SECONDS = 0.05;
export const MAX_CLIP_FADE_SECONDS = 5;
export const MIN_CLIP_GAIN_DB = -60;
export const MAX_CLIP_GAIN_DB = 20 * Math.log10(4);

export interface TimelineSnapResult {
  readonly anchorTime: number;
  readonly snapTime: number | null;
}

export function timelineEdgeScrollStep(
  pointerX: number,
  contentLeft: number,
  contentRight: number,
  edgeZone = 48,
  maximumStep = 24,
): number {
  if (pointerX < contentLeft + edgeZone) {
    const penetration = Math.min(1, Math.max(0, (contentLeft + edgeZone - pointerX) / Math.max(1, edgeZone)));
    return -maximumStep * penetration;
  }
  if (pointerX > contentRight - edgeZone) {
    const penetration = Math.min(1, Math.max(0, (pointerX - (contentRight - edgeZone)) / Math.max(1, edgeZone)));
    return maximumStep * penetration;
  }
  return 0;
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

export function linearGainToDb(volume: number): number {
  if (volume <= 0) return MIN_CLIP_GAIN_DB;
  return Math.min(MAX_CLIP_GAIN_DB, Math.max(MIN_CLIP_GAIN_DB, 20 * Math.log10(volume)));
}

export function dbToLinearGain(db: number): number {
  if (db <= MIN_CLIP_GAIN_DB) return 0;
  return Math.min(4, Math.max(0, 10 ** (Math.min(MAX_CLIP_GAIN_DB, db) / 20)));
}

export function gainToTrackPercent(volume: number): number {
  const db = linearGainToDb(volume);
  return (MAX_CLIP_GAIN_DB - db) / (MAX_CLIP_GAIN_DB - MIN_CLIP_GAIN_DB) * 100;
}

export function adjustLinearGainByTrackDelta(volume: number, deltaY: number, trackHeight: number): number {
  const dbRange = MAX_CLIP_GAIN_DB - MIN_CLIP_GAIN_DB;
  const nextDb = linearGainToDb(volume) - deltaY / Math.max(1, trackHeight) * dbRange;
  return dbToLinearGain(nextDb);
}

export function clipHasActiveTransition(value: string | null): boolean {
  const normalized = value?.trim().toLowerCase() ?? '';
  return normalized !== '' && normalized !== 'none' && normalized !== 'cut';
}

export function clipTransitionDuration(clip: TimelineClip): number {
  if (typeof clip.metadata === 'object' && clip.metadata !== null && !Array.isArray(clip.metadata)) {
    const duration = clip.metadata.transition_duration;
    if (typeof duration === 'number' && Number.isFinite(duration)) return duration;
  }
  return DEFAULT_CLIP_FADE_SECONDS;
}

export function clipFadeDuration(clip: TimelineClip, edge: 'in' | 'out'): number {
  return clipHasActiveTransition(edge === 'in' ? clip.transition_in : clip.transition_out)
    ? clipTransitionDuration(clip)
    : 0;
}

export function maximumClipFadeDuration(clip: TimelineClip, edge: 'in' | 'out', fps: number): number {
  const other = edge === 'in' ? clip.transition_out : clip.transition_in;
  const frame = 1 / Math.max(1, fps);
  const available = clipHasActiveTransition(other)
    ? clip.placement.duration / 2 - frame
    : clip.placement.duration - frame;
  return Math.max(0, Math.min(MAX_CLIP_FADE_SECONDS, available));
}

export function setClipFadeDuration(
  clip: TimelineClip,
  edge: 'in' | 'out',
  requestedDuration: number,
  fps: number,
): TimelineClip {
  const transitionField = edge === 'in' ? 'transition_in' : 'transition_out';
  if (requestedDuration < MIN_CLIP_FADE_SECONDS) {
    return clip[transitionField] === null ? clip : { ...clip, [transitionField]: null };
  }
  const maximum = maximumClipFadeDuration(clip, edge, fps);
  if (maximum < MIN_CLIP_FADE_SECONDS) return clip;
  const duration = snapTimeToFrame(
    Math.min(maximum, Math.max(MIN_CLIP_FADE_SECONDS, requestedDuration)),
    fps,
  );
  const metadata = typeof clip.metadata === 'object' && clip.metadata !== null && !Array.isArray(clip.metadata)
    ? clip.metadata
    : {};
  if (clip[transitionField] === 'fade'
    && typeof metadata.transition_duration === 'number'
    && Math.abs(metadata.transition_duration - duration) <= 1e-6) return clip;
  return {
    ...clip,
    [transitionField]: 'fade',
    metadata: { ...metadata, transition_duration: duration },
  };
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

export function constrainClipGroupTrimDelta(
  clips: readonly TimelineClip[],
  edge: 'start' | 'end',
  requestedDelta: number,
  fps: number,
): number {
  const frame = 1 / Math.max(1, fps);
  let minimum = Number.NEGATIVE_INFINITY;
  let maximum = Number.POSITIVE_INFINITY;
  for (const clip of clips) {
    const placement = clip.placement;
    if (edge === 'start') {
      minimum = Math.max(minimum, -placement.start, -placement.source_in / placement.speed);
      maximum = Math.min(maximum, placement.duration - frame);
    } else {
      minimum = Math.max(minimum, -(placement.duration - frame));
      const mediaDuration = clipMediaDuration(clip);
      if (mediaDuration !== null) {
        maximum = Math.min(maximum, (mediaDuration - placement.source_out) / placement.speed);
      }
    }
  }
  const snapped = Math.round(requestedDelta * Math.max(1, fps)) / Math.max(1, fps);
  return Math.min(maximum, Math.max(minimum, snapped));
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
    const minimumStart = Math.max(0, placement.start - placement.source_in / placement.speed);
    const nextStart = snapTimeToFrame(Math.min(maximumStart, Math.max(minimumStart, timelineSeconds)), fps);
    const timelineDelta = nextStart - placement.start;
    const nextSourceIn = Math.max(0, Math.min(
      placement.source_out - minimumDuration * placement.speed,
      placement.source_in + timelineDelta * placement.speed,
    ));
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
