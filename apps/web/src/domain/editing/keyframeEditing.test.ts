import { describe, expect, it } from 'vitest';

import type { TimelineClip } from '../../shared/desktop/dto';
import {
  canAnimateTransformProperty,
  clipKeyframeAtTime,
  clipLocalTimeAtTimeline,
  evaluateClipKeyframeProperty,
  removeClipKeyframe,
  setClipTransformAtTime,
  setClipVolumeAtTime,
  upsertClipKeyframe,
} from './keyframeEditing';

const CLIP: TimelineClip = {
  id: 'clip',
  name: 'Clip',
  capture_intent: null,
  material: { kind: 'asset', asset_id: 'asset', media_duration_seconds: 12 },
  placement: { start: 10, duration: 8, source_in: 2, source_out: 10, speed: 1, volume: 1, enabled: true },
  transform: { x: 0, y: 0, scale_x: 1, scale_y: 1, rotation: 0, opacity: 1 },
  effects: [],
  transition_in: null,
  transition_out: null,
  text: null,
  metadata: {},
  group_id: null,
  link_group_id: null,
  keyframes: [],
  speed_segments: [],
};

describe('canonical clip keyframe editing', () => {
  it('maps the global playhead into clamped frame-aligned clip-local time', () => {
    expect(clipLocalTimeAtTimeline(CLIP, 11.019, 60)).toBeCloseTo(1.016_666_667);
    expect(clipLocalTimeAtTimeline(CLIP, 30, 60)).toBe(8);
  });

  it('inserts sorted property keyframes and updates the same frame in place', () => {
    const later = upsertClipKeyframe(CLIP, 'x', 4, 120, 'later', 60);
    const earlier = upsertClipKeyframe(later, 'x', 1, 30, 'earlier', 60);
    const updated = upsertClipKeyframe(earlier, 'x', 1.004, 40, 'replacement', 60);

    expect(updated.keyframes).toEqual([
      { id: 'earlier', time: 1, property: 'x', value: 40 },
      { id: 'later', time: 4, property: 'x', value: 120 },
    ]);
    expect(clipKeyframeAtTime(updated, 'x', 1, 60)?.value).toBe(40);
  });

  it('removes only the addressed property on the current frame', () => {
    const x = upsertClipKeyframe(CLIP, 'x', 1, 20, 'x', 60);
    const both = upsertClipKeyframe(x, 'opacity', 1, 0.5, 'opacity', 60);
    const removed = removeClipKeyframe(both, 'x', 1, 60);

    expect(removed.keyframes).toEqual([{ id: 'opacity', time: 1, property: 'opacity', value: 0.5 }]);
    expect(removeClipKeyframe(removed, 'x', 1, 60)).toBe(removed);
  });

  it('evaluates the same held and linear values as the renderer expression', () => {
    const first = upsertClipKeyframe(CLIP, 'x', 2, 20, 'first', 60);
    const animated = upsertClipKeyframe(first, 'x', 6, 100, 'second', 60);

    expect(evaluateClipKeyframeProperty(animated, 'x', 0, 0)).toBe(20);
    expect(evaluateClipKeyframeProperty(animated, 'x', 4, 0)).toBe(60);
    expect(evaluateClipKeyframeProperty(animated, 'x', 8, 0)).toBe(100);
    expect(evaluateClipKeyframeProperty(CLIP, 'x', 4, 7)).toBe(7);
  });

  it('updates animated properties at the playhead and static properties at the base', () => {
    const animated = upsertClipKeyframe(CLIP, 'x', 0, 10, 'x-0', 60);
    let nextId = 0;
    const moved = setClipTransformAtTime(
      animated,
      1,
      { x: 100, y: 50 },
      60,
      () => `new-${nextId += 1}`,
    );

    expect(moved.transform).toMatchObject({ x: 0, y: 50 });
    expect(moved.keyframes).toEqual([
      { id: 'x-0', time: 0, property: 'x', value: 10 },
      { id: 'new-1', time: 1, property: 'x', value: 100 },
    ]);
  });

  it('mirrors the renderer animated-scale and rotation exclusion', () => {
    expect(canAnimateTransformProperty(CLIP, 'scale_x')).toBe(true);
    expect(canAnimateTransformProperty({ ...CLIP, transform: { ...CLIP.transform, rotation: 5 } }, 'scale_x')).toBe(false);
    const rotated = upsertClipKeyframe(CLIP, 'rotation', 0, 10, 'rotation', 60);
    expect(canAnimateTransformProperty(rotated, 'scale_y')).toBe(false);
    const scaled = upsertClipKeyframe(CLIP, 'scale_x', 0, 1.2, 'scale', 60);
    expect(canAnimateTransformProperty(scaled, 'rotation')).toBe(false);
    expect(canAnimateTransformProperty(scaled, 'opacity')).toBe(true);
  });

  it('updates static volume or the current animated volume frame', () => {
    const staticVolume = setClipVolumeAtTime(CLIP, 1, 2, 60, 'unused');
    expect(staticVolume.placement.volume).toBe(2);
    expect(staticVolume.keyframes).toEqual([]);

    const animated = upsertClipKeyframe(CLIP, 'volume', 0, 1, 'volume-0', 60);
    const keyed = setClipVolumeAtTime(animated, 1, 1.5, 60, 'volume-1');
    expect(keyed.placement.volume).toBe(1);
    expect(keyed.keyframes).toEqual([
      { id: 'volume-0', time: 0, property: 'volume', value: 1 },
      { id: 'volume-1', time: 1, property: 'volume', value: 1.5 },
    ]);
  });
});
