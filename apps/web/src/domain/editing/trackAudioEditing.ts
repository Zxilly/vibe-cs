import type { EditorKeyframe, TimelineTrack } from '../../shared/desktop/dto';
import { snapTimeToFrame } from './timelineInteraction';
import { evaluateEditorKeyframes } from './keyframeEditing';

export type TrackAudioProperty = 'volume' | 'pan';

export function trackAudioPropertyValue(track: TimelineTrack, property: TrackAudioProperty): number {
  return track[property];
}

export function trackAudioKeyframeAtTime(
  track: TimelineTrack,
  property: TrackAudioProperty,
  timelineTime: number,
  fps: number,
): EditorKeyframe | null {
  const tolerance = 0.5 / Math.max(1, fps);
  return track.keyframes.find((keyframe) => keyframe.property === property
    && Math.abs(keyframe.time - timelineTime) <= tolerance) ?? null;
}

export function evaluateTrackAudioProperty(
  track: TimelineTrack,
  property: TrackAudioProperty,
  timelineTime: number,
): number {
  return evaluateEditorKeyframes(track.keyframes, property, timelineTime, trackAudioPropertyValue(track, property));
}

export function setTrackAudioAtTime(
  track: TimelineTrack,
  property: TrackAudioProperty,
  timelineTime: number,
  value: number,
  fps: number,
  keyframeId: string,
): TimelineTrack {
  const constrained = constrainTrackAudioValue(property, value);
  if (!track.keyframes.some((keyframe) => keyframe.property === property)) {
    return { ...track, [property]: constrained };
  }
  return upsertTrackAudioKeyframe(track, property, timelineTime, constrained, fps, keyframeId);
}

export function upsertTrackAudioKeyframe(
  track: TimelineTrack,
  property: TrackAudioProperty,
  timelineTime: number,
  value: number,
  fps: number,
  keyframeId: string,
): TimelineTrack {
  const time = snapTimeToFrame(Math.max(0, timelineTime), fps);
  const existing = trackAudioKeyframeAtTime(track, property, time, fps);
  const keyframe: EditorKeyframe = {
    ...(existing ?? { id: keyframeId, interpolation: 'linear' as const, in_tangent: 0, out_tangent: 0 }),
    time,
    property,
    value: constrainTrackAudioValue(property, value),
  };
  const keyframes = existing === null
    ? [...track.keyframes, keyframe]
    : track.keyframes.map((candidate) => candidate.id === existing.id ? keyframe : candidate);
  return { ...track, keyframes: sortTrackAudioKeyframes(keyframes) };
}

export function removeTrackAudioKeyframe(
  track: TimelineTrack,
  property: TrackAudioProperty,
  timelineTime: number,
  fps: number,
): TimelineTrack {
  const existing = trackAudioKeyframeAtTime(track, property, timelineTime, fps);
  return existing === null
    ? track
    : { ...track, keyframes: track.keyframes.filter((keyframe) => keyframe.id !== existing.id) };
}

export function moveTrackAudioKeyframe(
  track: TimelineTrack,
  keyframeId: string,
  timelineTime: number,
  value: number,
  fps: number,
): TimelineTrack {
  const existing = track.keyframes.find((keyframe) => keyframe.id === keyframeId);
  if (existing === undefined || (existing.property !== 'volume' && existing.property !== 'pan')) return track;
  const time = snapTimeToFrame(Math.max(0, timelineTime), fps);
  const withoutExisting = track.keyframes.filter((keyframe) => keyframe.id !== keyframeId);
  const collision = withoutExisting.find((keyframe) => keyframe.property === existing.property
    && Math.abs(keyframe.time - time) <= 0.5 / Math.max(1, fps));
  const replacement: EditorKeyframe = {
    ...(collision ?? existing),
    id: collision?.id ?? keyframeId,
    property: existing.property,
    time,
    value: constrainTrackAudioValue(existing.property, value),
  };
  return {
    ...track,
    keyframes: sortTrackAudioKeyframes([
      ...withoutExisting.filter((keyframe) => keyframe.id !== collision?.id),
      replacement,
    ]),
  };
}

export function constrainTrackAudioValue(property: TrackAudioProperty, value: number): number {
  return property === 'volume'
    ? Math.min(4, Math.max(0, value))
    : Math.min(1, Math.max(-1, value));
}

function sortTrackAudioKeyframes(keyframes: readonly EditorKeyframe[]): EditorKeyframe[] {
  return [...keyframes].sort((left, right) => left.time - right.time || left.property.localeCompare(right.property));
}
