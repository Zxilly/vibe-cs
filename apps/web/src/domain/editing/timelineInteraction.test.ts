import { describe, expect, it } from 'vitest';

import type { TimelineClip } from '../../shared/desktop/dto';
import { moveTimelineClip, resolveTimelineSnap, snapTimeToFrame, trimTimelineClip } from './timelineInteraction';

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

describe('timeline direct manipulation', () => {
  it('snaps playhead and clip positions to the Editing Document frame grid', () => {
    expect(snapTimeToFrame(1.019, 60)).toBeCloseTo(1.016_666_667);
    expect(moveTimelineClip(CLIP, 14.019, 60).placement.start).toBeCloseTo(14.016_666_667);
  });

  it('trims the start while preserving the source/timeline relationship', () => {
    const trimmed = trimTimelineClip(CLIP, 'start', 12, 60, 12);
    expect(trimmed.placement).toMatchObject({ start: 12, duration: 6, source_in: 4, source_out: 10 });
  });

  it('trims the end without extending past recorded media', () => {
    const trimmed = trimTimelineClip(CLIP, 'end', 30, 60, 12);
    expect(trimmed.placement.duration).toBe(10);
    expect(trimmed.placement.source_out).toBe(12);
  });

  it('snaps the closest moving edge within a screen-derived threshold', () => {
    expect(resolveTimelineSnap(9.84, [0, 5], [0, 10, 20], 0.2)).toEqual({
      anchorTime: 10,
      snapTime: 10,
    });
    expect(resolveTimelineSnap(14.84, [0, 5], [0, 10, 20], 0.2)).toEqual({
      anchorTime: 15,
      snapTime: 20,
    });
  });

  it('does not snap outside the threshold', () => {
    expect(resolveTimelineSnap(9.7, [0], [10], 0.2)).toEqual({
      anchorTime: 9.7,
      snapTime: null,
    });
  });
});
