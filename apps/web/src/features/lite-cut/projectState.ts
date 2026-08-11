import { msg } from '../../shared/i18n';
import type { EditorPresetDocument, LiteCutMarker, TimelineTrackDto } from '../../shared/api/dto';

export const MAX_EDITOR_TIMELINE_SECONDS = 86_400;

export function boundedTimelineValue(
  value: number,
  fallback: number,
  minimum = 0,
  maximum = MAX_EDITOR_TIMELINE_SECONDS,
): number {
  const safeMinimum = Number.isFinite(minimum) ? minimum : 0;
  const safeMaximum = Number.isFinite(maximum) && maximum >= safeMinimum
    ? maximum
    : safeMinimum;
  const candidate = Number.isFinite(value) ? value : fallback;
  const safeCandidate = Number.isFinite(candidate) ? candidate : safeMinimum;
  return Math.max(safeMinimum, Math.min(safeMaximum, safeCandidate));
}

export function trimMarkersToDuration(
  markers: LiteCutMarker[],
  durationSeconds: number,
): { markers: LiteCutMarker[]; removed: number } {
  const duration = boundedTimelineValue(durationSeconds, 0);
  const kept = markers.filter((marker) => Number.isFinite(marker.time)
    && marker.time >= 0
    && marker.time <= duration);
  return { markers: kept, removed: markers.length - kept.length };
}

export type TimelineRuler = {
  stepSeconds: number;
  tickCount: number;
};

export function timelineRuler(
  durationSeconds: number,
  maximumTicks = 1_000,
): TimelineRuler {
  const duration = Math.max(70, boundedTimelineValue(durationSeconds, 0));
  const requestedTicks = Number.isFinite(maximumTicks) ? Math.floor(maximumTicks) : 1_000;
  const safeMaximumTicks = Math.max(2, Math.min(10_000, requestedTicks));
  const minimumStep = duration / (safeMaximumTicks - 1);
  const stepSeconds = Math.max(5, Math.ceil(minimumStep / 5) * 5);
  return {
    stepSeconds,
    tickCount: Math.floor(duration / stepSeconds) + 1,
  };
}

export function formatTimelineTime(seconds: number, fps: number): string {
  const safeSeconds = boundedTimelineValue(seconds, 0);
  const safeFps = Math.round(boundedTimelineValue(fps, 60, 1, 240));
  const totalFrames = Math.floor(safeSeconds * safeFps + 0.000_001);
  const framesPerMinute = safeFps * 60;
  const minutes = Math.floor(totalFrames / framesPerMinute);
  const secondsWithinMinute = Math.floor(totalFrames / safeFps) % 60;
  const frames = totalFrames % safeFps;
  const frameWidth = Math.max(2, String(safeFps - 1).length);
  return `${String(minutes).padStart(2, '0')}:${String(secondsWithinMinute).padStart(2, '0')}:${String(frames).padStart(frameWidth, '0')}`;
}

export function presetCompatibilityReason(
  trackKind: TimelineTrackDto['kind'] | null,
  hasText: boolean,
  currentVolume: number | null,
  document: EditorPresetDocument | null,
): string | null {
  if (!trackKind || !document) return null;
  const color = document.color_adjust;
  const identityColor = color === null
    || (Math.abs(color.brightness) <= 0.000_001
      && Math.abs(color.contrast - 1) <= 0.000_001
      && Math.abs(color.saturation - 1) <= 0.000_001);
  const noVisualEffect = identityColor
    && !document.grayscale
    && (document.blur_radius === null || document.blur_radius <= 0.000_001);
  const transform = document.transform;
  const identityVisualTransform = Math.abs(transform.x) <= 0.000_001
    && Math.abs(transform.y) <= 0.000_001
    && Math.abs(transform.scale_x - 1) <= 0.000_001
    && Math.abs(transform.scale_y - 1) <= 0.000_001
    && Math.abs(transform.rotation) <= 0.000_001
    && Math.abs(transform.opacity - 1) <= 0.000_001;
  if (trackKind === 'audio' && (!identityVisualTransform || !noVisualEffect)) {
    return msg("m1301");
  }
  if (trackKind === 'text' || hasText) {
    const supportedTextTransform = Math.abs(transform.scale_x - 1) <= 0.000_001
      && Math.abs(transform.scale_y - 1) <= 0.000_001
      && Math.abs(transform.rotation) <= 0.000_001;
    if (!supportedTextTransform
      || !noVisualEffect
      || document.transition_in !== null
      || document.transition_out !== null
      || currentVolume === null
      || Math.abs(document.volume - currentVolume) > 0.000_001) {
      return msg("m0691");
    }
  }
  return null;
}

export type ProjectTransitionDecision = 'stay' | 'proceed' | 'confirm';

export function projectEditFingerprint(
  name: string,
  tracks: TimelineTrackDto[],
  markers: LiteCutMarker[] = [],
  settings: unknown = {},
  durationSeconds = 0,
): string {
  return JSON.stringify({ name, tracks, markers, settings, durationSeconds });
}

export type SnapResult = { time: number; snapped: boolean };

export function snapTimelineTime(
  candidate: number,
  tracks: TimelineTrackDto[],
  markers: LiteCutMarker[],
  playhead: number,
  thresholdSeconds: number,
  movingClipId?: string,
): SnapResult {
  const safeCandidate = Math.max(0, Number.isFinite(candidate) ? candidate : 0);
  if (!Number.isFinite(thresholdSeconds) || thresholdSeconds <= 0) {
    return { time: safeCandidate, snapped: false };
  }
  const points = [0, playhead, ...markers.map((marker) => marker.time)];
  tracks.forEach((track) => {
    track.clips.forEach((clip) => {
      if (clip.id === movingClipId) return;
      points.push(clip.start, clip.start + clip.duration);
    });
  });
  let best = safeCandidate;
  let bestDistance = thresholdSeconds + Number.EPSILON;
  points.forEach((point) => {
    if (!Number.isFinite(point) || point < 0) return;
    const distance = Math.abs(point - safeCandidate);
    if (distance < bestDistance || (distance === bestDistance && point < best)) {
      best = point;
      bestDistance = distance;
    }
  });
  return bestDistance <= thresholdSeconds
    ? { time: best, snapped: true }
    : { time: safeCandidate, snapped: false };
}

export function decideProjectTransition(
  activeProjectId: string,
  targetProjectId: string | null,
  currentFingerprint: string,
  savedFingerprint: string,
): ProjectTransitionDecision {
  if (targetProjectId === activeProjectId) return 'stay';
  return currentFingerprint === savedFingerprint ? 'proceed' : 'confirm';
}

export type OperationGate<T> = {
  current: () => T | null;
  tryStart: (operation: T) => boolean;
  finish: (operation: T) => boolean;
};

export function createOperationGate<T>(): OperationGate<T> {
  let active: T | null = null;
  return {
    current: () => active,
    tryStart: (operation) => {
      if (active !== null) return false;
      active = operation;
      return true;
    },
    finish: (operation) => {
      if (active !== operation) return false;
      active = null;
      return true;
    },
  };
}
