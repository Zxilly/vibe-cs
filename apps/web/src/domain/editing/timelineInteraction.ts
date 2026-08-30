import type { EditorSpeedSegment, TimelineClip } from '../../shared/desktop/dto';

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

export function clipTransition(
  clip: TimelineClip,
  channel: 'video' | 'audio',
  edge: 'in' | 'out',
) {
  return clip.transitions[`${channel}_${edge}`];
}

export function clipTransitionDuration(
  clip: TimelineClip,
  channel: 'video' | 'audio',
  edge: 'in' | 'out',
): number {
  return clipTransition(clip, channel, edge)?.duration_seconds ?? 0;
}

export function clipFadeDuration(clip: TimelineClip, edge: 'in' | 'out'): number {
  return clipTransitionDuration(clip, 'audio', edge);
}

export function clipAudioFadeFactor(clip: TimelineClip, localTime: number): number {
  const factor = (edge: 'in' | 'out') => {
    const transition = clipTransition(clip, 'audio', edge);
    if (transition === null) return 1;
    const elapsed = edge === 'in' ? localTime : clip.placement.duration - localTime;
    const progress = Math.min(1, Math.max(0, elapsed / transition.duration_seconds));
    return transition.kind === 'constant_power' ? Math.sin(progress * Math.PI / 2) : progress;
  };
  return Math.min(factor('in'), factor('out'));
}

export function maximumClipFadeDuration(clip: TimelineClip, edge: 'in' | 'out', fps: number): number {
  const frame = 1 / Math.max(1, fps);
  const available = clipTransition(clip, 'audio', edge === 'in' ? 'out' : 'in') !== null
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
  const transitionField = edge === 'in' ? 'audio_in' : 'audio_out';
  if (requestedDuration < MIN_CLIP_FADE_SECONDS) {
    return clip.transitions[transitionField] === null
      ? clip
      : { ...clip, transitions: { ...clip.transitions, [transitionField]: null } };
  }
  const maximum = maximumClipFadeDuration(clip, edge, fps);
  if (maximum < MIN_CLIP_FADE_SECONDS) return clip;
  const duration = snapTimeToFrame(
    Math.min(maximum, Math.max(MIN_CLIP_FADE_SECONDS, requestedDuration)),
    fps,
  );
  const current = clip.transitions[transitionField];
  if (current?.kind === 'constant_power'
    && Math.abs(current.duration_seconds - duration) <= 1e-6) return clip;
  return {
    ...clip,
    transitions: {
      ...clip.transitions,
      [transitionField]: { kind: 'constant_power', duration_seconds: duration },
    },
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
    if (clip.speed_segments.length > 0) {
      if (edge === 'start') {
        minimum = Math.max(minimum, 0);
        maximum = Math.min(maximum, placement.duration - frame);
      } else {
        minimum = Math.max(minimum, -(placement.duration - frame));
        maximum = Math.min(maximum, 0);
      }
      continue;
    }
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

  if (clip.speed_segments.length > 0) {
    if (edge === 'start') {
      const maximumStart = placement.start + placement.duration - minimumDuration;
      const nextStart = snapTimeToFrame(Math.min(maximumStart, Math.max(placement.start, timelineSeconds)), fps);
      const localStart = nextStart - placement.start;
      const nextSourceIn = clipSourceTimeAtLocalTime(clip, localStart);
      const nextDuration = placement.duration - localStart;
      return {
        ...clip,
        placement: {
          ...placement,
          start: nextStart,
          duration: nextDuration,
          source_in: nextSourceIn,
          speed: (placement.source_out - nextSourceIn) / nextDuration,
        },
        keyframes: clip.keyframes
          .filter((keyframe) => keyframe.time >= localStart - 1e-9)
          .map((keyframe) => ({ ...keyframe, time: keyframe.time - localStart })),
        speed_segments: sliceClipSpeedSegments(clip, localStart, placement.duration),
      };
    }
    const nextDuration = snapTimeToFrame(
      Math.min(placement.duration, Math.max(minimumDuration, timelineSeconds - placement.start)),
      fps,
    );
    const nextSourceOut = clipSourceTimeAtLocalTime(clip, nextDuration);
    return {
      ...clip,
      placement: {
        ...placement,
        duration: nextDuration,
        source_out: nextSourceOut,
        speed: (nextSourceOut - placement.source_in) / nextDuration,
      },
      keyframes: clip.keyframes.filter((keyframe) => keyframe.time <= nextDuration + 1e-9),
      speed_segments: sliceClipSpeedSegments(clip, 0, nextDuration),
    };
  }

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

/**
 * Maps a clip-local Timeline offset to its source-media time.
 *
 * This mirrors the export renderer's `source_offset_at`: segmented speed is a
 * piecewise integral, while ordinary clips use the canonical constant speed.
 * Program video, Timeline audio and auxiliary monitors must all consume this
 * function so their presented frame cannot disagree with the rendered frame.
 */
export function clipSourceTimeAtLocalTime(clip: TimelineClip, requestedLocalTime: number): number {
  const localTime = Math.min(clip.placement.duration, Math.max(0, requestedLocalTime));
  const sourceOffset = clip.speed_segments.length === 0
    ? localTime * clip.placement.speed
    : clip.speed_segments.reduce((offset, segment) => (
      localTime <= segment.start
        ? offset
        : offset + Math.max(0, Math.min(localTime, segment.end) - segment.start) * segment.speed
    ), 0);
  return Math.min(
    clip.placement.source_out,
    Math.max(clip.placement.source_in, clip.placement.source_in + sourceOffset),
  );
}

/** The inverse needed when a presented media frame advances the Timeline. */
export function clipLocalTimeAtSourceTime(clip: TimelineClip, requestedSourceTime: number): number {
  const sourceTime = Math.min(
    clip.placement.source_out,
    Math.max(clip.placement.source_in, requestedSourceTime),
  );
  const sourceOffset = sourceTime - clip.placement.source_in;
  if (clip.speed_segments.length === 0) {
    return Math.min(clip.placement.duration, Math.max(0, sourceOffset / clip.placement.speed));
  }
  let consumedSource = 0;
  for (const segment of clip.speed_segments) {
    const segmentSourceDuration = (segment.end - segment.start) * segment.speed;
    if (sourceOffset <= consumedSource + segmentSourceDuration) {
      return Math.min(
        clip.placement.duration,
        Math.max(0, segment.start + (sourceOffset - consumedSource) / segment.speed),
      );
    }
    consumedSource += segmentSourceDuration;
  }
  return clip.placement.duration;
}

/** Instantaneous source playback rate at one clip-local Timeline offset. */
export function clipPlaybackSpeedAtLocalTime(clip: TimelineClip, requestedLocalTime: number): number {
  if (clip.speed_segments.length === 0) return clip.placement.speed;
  const localTime = Math.min(clip.placement.duration, Math.max(0, requestedLocalTime));
  return clip.speed_segments.find((segment) => (
    localTime >= segment.start && (localTime < segment.end || localTime === clip.placement.duration)
  ))?.speed ?? clip.placement.speed;
}

/** Maps the shared Timeline Transport to the Demo tick captured by one Take. */
export function clipDemoTickAtTimelineTime(
  clip: TimelineClip,
  timelineTime: number,
  tickRate: number,
): number | null {
  const intent = clip.capture_intent;
  if (intent === null) return null;
  const localTime = Math.min(
    clip.placement.duration,
    Math.max(0, timelineTime - clip.placement.start),
  );
  const sourceTime = clipSourceTimeAtLocalTime(clip, localTime);
  return Math.round(
    intent.start_tick - intent.pre_roll_seconds * tickRate + sourceTime * tickRate,
  );
}

export function enableClipTimeRemapping(clip: TimelineClip, segmentId: string): TimelineClip {
  if (clip.speed_segments.length > 0) return clip;
  return {
    ...clip,
    speed_segments: [{
      id: segmentId,
      start: 0,
      end: clip.placement.duration,
      speed: clip.placement.speed,
    }],
  };
}

export function disableClipTimeRemapping(clip: TimelineClip): TimelineClip {
  if (clip.speed_segments.length === 0) return clip;
  const sourceDuration = clip.placement.source_out - clip.placement.source_in;
  return {
    ...clip,
    placement: {
      ...clip.placement,
      speed: sourceDuration / clip.placement.duration,
    },
    speed_segments: [],
  };
}

export function splitClipSpeedSegment(
  clip: TimelineClip,
  requestedLocalTime: number,
  segmentId: string,
  fps: number,
): TimelineClip {
  if (clip.speed_segments.length === 0) return clip;
  const localTime = snapTimeToFrame(
    Math.min(clip.placement.duration, Math.max(0, requestedLocalTime)),
    fps,
  );
  const frame = 1 / Math.max(1, fps);
  const index = clip.speed_segments.findIndex((segment) => (
    localTime > segment.start + 0.5 * frame && localTime < segment.end - 0.5 * frame
  ));
  const current = clip.speed_segments[index];
  if (current === undefined) return clip;
  const speedSegments = [...clip.speed_segments];
  speedSegments.splice(index, 1,
    { ...current, end: localTime },
    { ...current, id: segmentId, start: localTime });
  return { ...clip, speed_segments: speedSegments };
}

export function removeClipSpeedBoundary(clip: TimelineClip, rightSegmentId: string): TimelineClip {
  const rightIndex = clip.speed_segments.findIndex((segment) => segment.id === rightSegmentId);
  const left = clip.speed_segments[rightIndex - 1];
  const right = clip.speed_segments[rightIndex];
  if (left === undefined || right === undefined) return clip;
  const duration = right.end - left.start;
  const sourceDuration = (left.end - left.start) * left.speed + (right.end - right.start) * right.speed;
  const speedSegments = [...clip.speed_segments];
  speedSegments.splice(rightIndex - 1, 2, {
    ...left,
    end: right.end,
    speed: sourceDuration / duration,
  });
  return { ...clip, speed_segments: speedSegments };
}

export function setClipSpeedSegmentSpeed(
  clip: TimelineClip,
  segmentId: string,
  requestedSpeed: number,
  fps: number,
): TimelineClip {
  const segmentIndex = clip.speed_segments.findIndex((segment) => segment.id === segmentId);
  const segment = clip.speed_segments[segmentIndex];
  if (segment === undefined || !Number.isFinite(requestedSpeed)) return clip;
  const frameRate = Math.max(1, fps);
  const sourceDuration = (segment.end - segment.start) * segment.speed;
  const minimumFrames = Math.max(1, Math.ceil(sourceDuration / MAX_TIMELINE_CLIP_SPEED * frameRate - 1e-6));
  const maximumFrames = Math.max(minimumFrames, Math.floor(sourceDuration / MIN_TIMELINE_CLIP_SPEED * frameRate + 1e-6));
  const desiredSpeed = Math.min(MAX_TIMELINE_CLIP_SPEED, Math.max(MIN_TIMELINE_CLIP_SPEED, requestedSpeed));
  const frames = Math.min(maximumFrames, Math.max(minimumFrames, Math.round(sourceDuration / desiredSpeed * frameRate)));
  const duration = frames / frameRate;
  const speed = sourceDuration / duration;
  const oldEnd = segment.end;
  const nextEnd = segment.start + duration;
  const delta = nextEnd - oldEnd;
  if (Math.abs(delta) <= 1e-9 && Math.abs(speed - segment.speed) <= 1e-9) return clip;
  const speedSegments = clip.speed_segments.map((candidate, index): EditorSpeedSegment => {
    if (index < segmentIndex) return candidate;
    if (index === segmentIndex) return { ...candidate, end: nextEnd, speed };
    return { ...candidate, start: candidate.start + delta, end: candidate.end + delta };
  });
  const nextDuration = clip.placement.duration + delta;
  const totalSourceDuration = clip.placement.source_out - clip.placement.source_in;
  const ratio = duration / (segment.end - segment.start);
  return {
    ...clip,
    placement: {
      ...clip.placement,
      duration: nextDuration,
      speed: totalSourceDuration / nextDuration,
    },
    keyframes: clip.keyframes.map((keyframe) => ({
      ...keyframe,
      time: keyframe.time <= segment.start
        ? keyframe.time
        : keyframe.time < oldEnd
          ? segment.start + (keyframe.time - segment.start) * ratio
          : keyframe.time + delta,
    })),
    speed_segments: speedSegments,
  };
}

export function sliceClipSpeedSegments(
  clip: TimelineClip,
  localStart: number,
  localEnd: number,
): EditorSpeedSegment[] {
  if (clip.speed_segments.length === 0) return [];
  return clip.speed_segments.flatMap((segment) => {
    const start = Math.max(localStart, segment.start);
    const end = Math.min(localEnd, segment.end);
    return end <= start ? [] : [{
      ...segment,
      start: start - localStart,
      end: end - localStart,
    }];
  });
}
