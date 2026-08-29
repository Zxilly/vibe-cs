import { describe, expect, it } from 'vitest';

import type { TimelineClip } from '../../shared/desktop/dto';
import {
  clipKeyframeAtTime,
  clipLocalTimeAtTimeline,
  evaluateClipKeyframeProperty,
  removeClipKeyframe,
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
});
