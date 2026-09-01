import { describe, expect, it } from 'vitest';

import type { EditorMarker, TimelineClip } from '../../shared/desktop/dto';
import { planRippleSequenceMarkers } from './timelineMarkers';

const marker = (id: string, time: number, duration = 0): EditorMarker => ({
  id,
  time,
  duration,
  label: id,
  color: '#2F6FED',
  kind: 'comment',
  comment: '',
});

const clip = (id: string, start: number, duration: number): TimelineClip => ({
  id,
  name: id,
  capture_intent: null,
  material: { kind: 'planned' },
  placement: { start, duration, source_in: 0, source_out: duration, speed: 1, reverse: false, frame_hold_source_time: null, volume: 1, pan: 0, enabled: true },
  transform: { x: 0, y: 0, scale_x: 1, scale_y: 1, rotation: 0, opacity: 1 },
  effects: [],
  transitions: { video_in: null, video_out: null, audio_in: null, audio_out: null },
  text: null,
  metadata: {},
  group_id: null,
  link_group_id: null,
  keyframes: [],
  speed_segments: [],
});

describe('sequence marker ripple planning', () => {
  it('moves downstream markers and resizes a marker spanning the edit point', () => {
    const plan = planRippleSequenceMarkers(
      [marker('before', 2), marker('span', 4, 3), marker('after', 8)],
      [clip('a', 0, 5), clip('b', 5, 5)],
      [clip('a', 0, 3), clip('b', 3, 5)],
      true,
      60,
    );
    expect(plan).toMatchObject({ pivot: 5, delta: -2 });
    expect(plan?.markers.map((item) => [item.id, item.time, item.duration])).toEqual([
      ['before', 2, 0],
      ['span', 4, 1],
      ['after', 6, 0],
    ]);
  });

  it('leaves markers fixed when the setting is disabled', () => {
    expect(planRippleSequenceMarkers(
      [marker('fixed', 8)],
      [clip('a', 0, 5), clip('b', 5, 5)],
      [clip('a', 0, 3), clip('b', 3, 5)],
      false,
      60,
    )).toBeNull();
  });

  it('uses the old Story end when the last clip changes duration', () => {
    const plan = planRippleSequenceMarkers(
      [marker('tail', 10), marker('later', 12)],
      [clip('a', 0, 10)],
      [clip('a', 0, 8)],
      true,
      60,
    );
    expect(plan).toMatchObject({ pivot: 10, delta: -2 });
    expect(plan?.markers.map((item) => item.time)).toEqual([8, 10]);
  });
});
