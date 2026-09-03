import type { EditorKeyframe, EditorKeyframeProperty, TimelineClip } from '../../shared/desktop/dto';
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
  const keyframe = existing === null
    ? { id: keyframeId, time, property, value, interpolation: 'linear' as const, in_tangent: 0, out_tangent: 0 }
    : { ...existing, time, value };
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

type ClipTransformProperty = Exclude<EditorKeyframeProperty, 'volume' | 'pan'>;

export function setClipTransformAtTime(
  clip: TimelineClip,
  localTime: number,
  values: Partial<Record<ClipTransformProperty, number>>,
  fps: number,
  createId: () => string,
): TimelineClip {
  let next = clip;
  for (const [property, value] of Object.entries(values) as Array<[
    ClipTransformProperty,
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

export function setClipVolumeAtTime(
  clip: TimelineClip,
  localTime: number,
  volume: number,
  fps: number,
  keyframeId: string,
): TimelineClip {
  const constrained = Math.min(4, Math.max(0, volume));
  return clip.keyframes.some((keyframe) => keyframe.property === 'volume')
    ? upsertClipKeyframe(clip, 'volume', localTime, constrained, keyframeId, fps)
    : { ...clip, placement: { ...clip.placement, volume: constrained } };
}

export function setClipPanAtTime(
  clip: TimelineClip,
  localTime: number,
  pan: number,
  fps: number,
  keyframeId: string,
): TimelineClip {
  const constrained = Math.min(1, Math.max(-1, pan));
  return clip.keyframes.some((keyframe) => keyframe.property === 'pan')
    ? upsertClipKeyframe(clip, 'pan', localTime, constrained, keyframeId, fps)
    : { ...clip, placement: { ...clip.placement, pan: constrained } };
}

export function canAnimateTransformProperty(
  clip: TimelineClip,
  property: ClipTransformProperty,
): boolean {
  const hasScaleKeyframes = clip.keyframes.some((keyframe) => keyframe.property === 'scale_x' || keyframe.property === 'scale_y');
  const hasRotationKeyframes = clip.keyframes.some((keyframe) => keyframe.property === 'rotation');
  if (property === 'scale_x' || property === 'scale_y') {
    return Math.abs(clip.transform.rotation) <= 1e-6 && !hasRotationKeyframes;
  }
  if (property === 'rotation') return !hasScaleKeyframes;
  return true;
}

export function evaluateClipKeyframeProperty(
  clip: TimelineClip,
  property: EditorKeyframeProperty,
  localTime: number,
  fallback: number,
): number {
  return evaluateEditorKeyframes(clip.keyframes, property, localTime, fallback);
}

export function evaluateEditorKeyframes(
  keyframes: readonly EditorKeyframe[],
  property: EditorKeyframeProperty,
  time: number,
  fallback: number,
): number {
  const points = keyframes
    .filter((keyframe) => keyframe.property === property)
    .sort((left, right) => left.time - right.time);
  const first = points[0];
  if (first === undefined) return fallback;
  if (time <= first.time) return first.value;
  const last = points[points.length - 1]!;
  if (time >= last.time) return last.value;
  for (let index = 1; index < points.length; index += 1) {
    const right = points[index]!;
    if (time > right.time) continue;
    const left = points[index - 1]!;
    const duration = right.time - left.time;
    const progress = (time - left.time) / duration;
    if (left.interpolation === 'hold') return left.value;
    if (left.interpolation === 'linear') return left.value + (right.value - left.value) * progress;
    const slope = (right.value - left.value) / duration;
    const [outTangent, inTangent] = left.interpolation === 'bezier'
      ? [left.out_tangent, right.in_tangent]
      : left.interpolation === 'ease_in'
        ? [0, slope]
        : left.interpolation === 'ease_out'
          ? [slope, 0]
          : [0, 0];
    const p2 = progress * progress;
    const p3 = p2 * progress;
    return (2 * p3 - 3 * p2 + 1) * left.value
      + (p3 - 2 * p2 + progress) * duration * outTangent
      + (-2 * p3 + 3 * p2) * right.value
      + (p3 - p2) * duration * inTangent;
  }
  return last.value;
}
