import type { EditorKeyframeProperty, TimelineClip } from '../../shared/desktop/dto';
import { snapTimeToFrame } from './timelineInteraction';

export function clipLocalTimeAtTimeline(clip: TimelineClip, timelineTime: number, fps: number): number {
  return snapTimeToFrame(
    Math.min(clip.placement.duration, Math.max(0, timelineTime - clip.placement.start)),
    fps,
  );
}

export function clipKeyframeAtTime(
  clip: TimelineClip,
  property: EditorKeyframeProperty,
  localTime: number,
  fps: number,
) {
  const frameTolerance = 0.5 / Math.max(1, fps);
  return clip.keyframes.find((keyframe) => keyframe.property === property
    && Math.abs(keyframe.time - localTime) <= frameTolerance) ?? null;
}

export function upsertClipKeyframe(
  clip: TimelineClip,
  property: EditorKeyframeProperty,
  localTime: number,
  value: number,
  keyframeId: string,
  fps: number,
): TimelineClip {
  const time = snapTimeToFrame(Math.min(clip.placement.duration, Math.max(0, localTime)), fps);
  const existing = clipKeyframeAtTime(clip, property, time, fps);
  const keyframe = { id: existing?.id ?? keyframeId, time, property, value };
  const keyframes = existing === null
    ? [...clip.keyframes, keyframe]
    : clip.keyframes.map((candidate) => candidate.id === existing.id ? keyframe : candidate);
  return {
    ...clip,
    keyframes: keyframes.sort((left, right) => left.time - right.time || left.property.localeCompare(right.property)),
  };
}

export function removeClipKeyframe(
  clip: TimelineClip,
  property: EditorKeyframeProperty,
  localTime: number,
  fps: number,
): TimelineClip {
  const existing = clipKeyframeAtTime(clip, property, localTime, fps);
  if (existing === null) return clip;
  return { ...clip, keyframes: clip.keyframes.filter((keyframe) => keyframe.id !== existing.id) };
}

export function transformPropertyValue(clip: TimelineClip, property: Exclude<EditorKeyframeProperty, 'volume'>): number {
  return clip.transform[property];
}

export function setClipTransformAtTime(
  clip: TimelineClip,
  localTime: number,
  values: Partial<Record<Exclude<EditorKeyframeProperty, 'volume'>, number>>,
  fps: number,
  createId: () => string,
): TimelineClip {
  let next = clip;
  for (const [property, value] of Object.entries(values) as Array<[
    Exclude<EditorKeyframeProperty, 'volume'>,
    number,
  ]>) {
    if (value === undefined) continue;
    if (next.keyframes.some((keyframe) => keyframe.property === property)) {
      next = upsertClipKeyframe(next, property, localTime, value, createId(), fps);
    } else {
      next = { ...next, transform: { ...next.transform, [property]: value } };
    }
  }
  return next;
}

export function evaluateClipKeyframeProperty(
  clip: TimelineClip,
  property: EditorKeyframeProperty,
  localTime: number,
  fallback: number,
): number {
  const keyframes = clip.keyframes
    .filter((keyframe) => keyframe.property === property)
    .sort((left, right) => left.time - right.time);
  const first = keyframes[0];
  if (first === undefined) return fallback;
  if (localTime <= first.time) return first.value;
  const last = keyframes[keyframes.length - 1]!;
  if (localTime >= last.time) return last.value;
  for (let index = 1; index < keyframes.length; index += 1) {
    const right = keyframes[index]!;
    if (localTime > right.time) continue;
    const left = keyframes[index - 1]!;
    const progress = (localTime - left.time) / (right.time - left.time);
    return left.value + (right.value - left.value) * progress;
  }
  return last.value;
}
