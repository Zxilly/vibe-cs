import type { TimelineClip } from '../../shared/desktop/dto';

const MINIMUM_CLIP_FRAMES = 1;
export const MIN_TIMELINE_CLIP_SPEED = 0.0625;
export const MAX_TIMELINE_CLIP_SPEED = 16;
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

export function canSlipTimelineClip(clip: TimelineClip, fps: number): boolean {
  const mediaDuration = clipMediaDuration(clip);
  if (mediaDuration === null) return false;
  const frame = 1 / Math.max(1, fps);
  return clip.placement.source_in >= frame - 1e-9
    || mediaDuration - clip.placement.source_out >= frame - 1e-9;
}

/**
 * Constrain one source-time delta so every selected clip can slip without
 * crossing its media In/Out boundaries. Timeline position and duration are
 * deliberately absent from this calculation.
 */
export function constrainClipGroupSlipDelta(
  clips: readonly TimelineClip[],
  requestedSourceDelta: number,
  fps: number,
): number {
  if (clips.length === 0) return 0;
  let minimum = Number.NEGATIVE_INFINITY;
  let maximum = Number.POSITIVE_INFINITY;
  for (const clip of clips) {
    const mediaDuration = clipMediaDuration(clip);
    if (mediaDuration === null) return 0;
    minimum = Math.max(minimum, -clip.placement.source_in);
    maximum = Math.min(maximum, mediaDuration - clip.placement.source_out);
  }
  const frameRate = Math.max(1, fps);
  const minimumFrames = Math.ceil(minimum * frameRate - 1e-6);
  const maximumFrames = Math.floor(maximum * frameRate + 1e-6);
  if (minimumFrames > maximumFrames) return 0;
  const requestedFrames = Math.round(requestedSourceDelta * frameRate);
  return Math.min(maximumFrames, Math.max(minimumFrames, requestedFrames)) / frameRate;
}

export function slipTimelineClip(clip: TimelineClip, sourceDelta: number, fps: number): TimelineClip {
  const delta = constrainClipGroupSlipDelta([clip], sourceDelta, fps);
  if (Math.abs(delta) <= 1e-9) return clip;
  return {
    ...clip,
    placement: {
      ...clip.placement,
      source_in: clip.placement.source_in + delta,
      source_out: clip.placement.source_out + delta,
    },
  };
}

export interface TimelineRollingEdit {
  readonly left: TimelineClip;
  readonly right: TimelineClip;
  readonly editTime: number;
  readonly delta: number;
}

export interface TimelineRollingPreview {
  readonly leftClipId: string;
  readonly rightClipId: string;
  readonly editTime: number;
}

export function rollTimelineEdit(
  left: TimelineClip,
  right: TimelineClip,
  requestedEditTime: number,
  fps: number,
): TimelineRollingEdit | null {
  const frameRate = Math.max(1, fps);
  const frame = 1 / frameRate;
  const editTime = left.placement.start + left.placement.duration;
  if (Math.abs(right.placement.start - editTime) > 0.5 * frame
    || left.speed_segments.length > 0
    || right.speed_segments.length > 0) return null;

  const minimum = Math.max(
    minimumClipTimelineDuration(left, fps) - left.placement.duration,
    -right.placement.source_in / right.placement.speed,
  );
  let maximum = right.placement.duration - minimumClipTimelineDuration(right, fps);
  const leftMediaDuration = clipMediaDuration(left);
  if (leftMediaDuration !== null) {
    maximum = Math.min(
      maximum,
      (leftMediaDuration - left.placement.source_out) / left.placement.speed,
    );
  }
  const minimumFrames = Math.ceil(minimum * frameRate - 1e-6);
  const maximumFrames = Math.floor(maximum * frameRate + 1e-6);
  if (minimumFrames > maximumFrames) return null;
  const requestedFrames = Math.round((requestedEditTime - editTime) * frameRate);
  const delta = Math.min(maximumFrames, Math.max(minimumFrames, requestedFrames)) / frameRate;
  const nextEditTime = editTime + delta;
  return {
    left: {
      ...left,
      placement: {
        ...left.placement,
        duration: left.placement.duration + delta,
        source_out: left.placement.source_out + delta * left.placement.speed,
      },
    },
    right: {
      ...right,
      placement: {
        ...right.placement,
        start: nextEditTime,
        duration: right.placement.duration - delta,
        source_in: right.placement.source_in + delta * right.placement.speed,
      },
    },
    editTime: nextEditTime,
    delta,
  };
}

export function canRollTimelineEdit(left: TimelineClip, right: TimelineClip, fps: number): boolean {
  const editTime = left.placement.start + left.placement.duration;
  const earlier = rollTimelineEdit(left, right, editTime - 1 / Math.max(1, fps), fps);
  const later = rollTimelineEdit(left, right, editTime + 1 / Math.max(1, fps), fps);
  return (earlier !== null && earlier.delta < -1e-9) || (later !== null && later.delta > 1e-9);
}

export interface TimelineSlideEdit {
  readonly previous: TimelineClip;
  readonly clip: TimelineClip;
  readonly next: TimelineClip;
  readonly delta: number;
}

export interface TimelineSlidePreview {
  readonly previousClipId: string;
  readonly clipId: string;
  readonly nextClipId: string;
  readonly startTime: number;
}

export function slideTimelineClip(
  previous: TimelineClip,
  clip: TimelineClip,
  next: TimelineClip,
  requestedStart: number,
  fps: number,
): TimelineSlideEdit | null {
  const frameRate = Math.max(1, fps);
  const frame = 1 / frameRate;
  const clipEnd = clip.placement.start + clip.placement.duration;
  if (Math.abs(previous.placement.start + previous.placement.duration - clip.placement.start) > 0.5 * frame
    || Math.abs(next.placement.start - clipEnd) > 0.5 * frame
    || previous.speed_segments.length > 0
    || next.speed_segments.length > 0) return null;

  const minimum = Math.max(
    minimumClipTimelineDuration(previous, fps) - previous.placement.duration,
    -next.placement.source_in / next.placement.speed,
  );
  let maximum = next.placement.duration - minimumClipTimelineDuration(next, fps);
  const previousMediaDuration = clipMediaDuration(previous);
  if (previousMediaDuration !== null) {
    maximum = Math.min(
      maximum,
      (previousMediaDuration - previous.placement.source_out) / previous.placement.speed,
    );
  }
  const minimumFrames = Math.ceil(minimum * frameRate - 1e-6);
  const maximumFrames = Math.floor(maximum * frameRate + 1e-6);
  if (minimumFrames > maximumFrames) return null;
  const requestedFrames = Math.round((requestedStart - clip.placement.start) * frameRate);
  const delta = Math.min(maximumFrames, Math.max(minimumFrames, requestedFrames)) / frameRate;
  return {
    previous: {
      ...previous,
      placement: {
        ...previous.placement,
        duration: previous.placement.duration + delta,
        source_out: previous.placement.source_out + delta * previous.placement.speed,
      },
    },
    clip: {
      ...clip,
      placement: { ...clip.placement, start: clip.placement.start + delta },
    },
    next: {
      ...next,
      placement: {
        ...next.placement,
        start: next.placement.start + delta,
        duration: next.placement.duration - delta,
        source_in: next.placement.source_in + delta * next.placement.speed,
      },
    },
    delta,
  };
}

export function canSlideTimelineClip(
  previous: TimelineClip,
  clip: TimelineClip,
  next: TimelineClip,
  fps: number,
): boolean {
  const frame = 1 / Math.max(1, fps);
  const earlier = slideTimelineClip(previous, clip, next, clip.placement.start - frame, fps);
  const later = slideTimelineClip(previous, clip, next, clip.placement.start + frame, fps);
  return (earlier !== null && earlier.delta < -1e-9) || (later !== null && later.delta > 1e-9);
}

export function canRateStretchTimelineClip(clip: TimelineClip): boolean {
  return clip.speed_segments.length === 0
    && clip.placement.source_out - clip.placement.source_in > 1e-9;
}

export function rateStretchTimelineClip(
  clip: TimelineClip,
  edge: 'start' | 'end',
  requestedTimelineTime: number,
  fps: number,
): TimelineClip {
  if (!canRateStretchTimelineClip(clip)) return clip;
  const frameRate = Math.max(1, fps);
  const placement = clip.placement;
  const sourceDuration = placement.source_out - placement.source_in;
  const fixedEnd = placement.start + placement.duration;
  const requestedDuration = edge === 'start'
    ? fixedEnd - requestedTimelineTime
    : requestedTimelineTime - placement.start;
  const minimumDuration = Math.max(
    minimumClipTimelineDuration(clip, fps),
    sourceDuration / MAX_TIMELINE_CLIP_SPEED,
  );
  const maximumDuration = Math.min(
    sourceDuration / MIN_TIMELINE_CLIP_SPEED,
    edge === 'start' ? fixedEnd : Number.POSITIVE_INFINITY,
  );
  if (minimumDuration > maximumDuration + 1e-9) return clip;
  const minimumFrames = Math.ceil(minimumDuration * frameRate - 1e-6);
  const maximumFrames = Math.max(minimumFrames, Math.floor(maximumDuration * frameRate + 1e-6));
  const durationFrames = Math.min(maximumFrames, Math.max(
    minimumFrames,
    Math.round(requestedDuration * frameRate),
  ));
  const duration = durationFrames / frameRate;
  const ratio = duration / placement.duration;
  return {
    ...clip,
    placement: {
      ...placement,
      start: edge === 'start' ? fixedEnd - duration : placement.start,
      duration,
      speed: sourceDuration / duration,
    },
    keyframes: clip.keyframes.map((keyframe) => ({
      ...keyframe,
      time: Math.round(keyframe.time * ratio * frameRate) / frameRate,
    })),
  };
}

function minimumClipTimelineDuration(clip: TimelineClip, fps: number): number {
  const frame = 1 / Math.max(1, fps);
  const fadeIn = clipFadeDuration(clip, 'in');
  const fadeOut = clipFadeDuration(clip, 'out');
  if (fadeIn > 0 && fadeOut > 0) return 2 * Math.max(fadeIn, fadeOut) + frame;
  const fade = Math.max(fadeIn, fadeOut);
  return fade > 0 ? fade + frame : frame;
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
