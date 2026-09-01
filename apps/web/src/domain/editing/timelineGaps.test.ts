import { describe, expect, it } from 'vitest';

import type { TimelineClip } from '../../shared/desktop/dto';
import { closeAllTimelineGaps, closeTimelineGap, timelineGaps } from './timelineGaps';

function clip(id: string, start: number, duration: number): TimelineClip {
  return {
    id, name: id, capture_intent: null, material: { kind: 'planned' },
    placement: { start, duration, source_in: 0, source_out: duration, speed: 1, volume: 1, pan: 0, enabled: true },
    transform: { x: 0, y: 0, scale_x: 1, scale_y: 1, rotation: 0, opacity: 1 }, effects: [],
    transitions: { video_in: null, video_out: null, audio_in: null, audio_out: null }, text: null,
    metadata: {}, group_id: null, link_group_id: null, keyframes: [], speed_segments: [],
  };
}

describe('free-track Timeline gaps', () => {
  it('detects leading and internal gaps but not trailing empty sequence time', () => {
    expect(timelineGaps([clip('a', 2, 2), clip('b', 7, 1)])).toEqual([
      { start: 0, end: 2, duration: 2 },
      { start: 4, end: 7, duration: 3 },
    ]);
  });

  it('closes one selected gap without moving earlier clips', () => {
    const clips = [clip('a', 2, 2), clip('b', 7, 1), clip('c', 9, 1)];
    expect(closeTimelineGap(clips, timelineGaps(clips)[1]!).map((item) => item.placement.start)).toEqual([2, 4, 6]);
  });

  it('closes every gap into a packed free track', () => {
    expect(closeAllTimelineGaps([clip('a', 2, 2), clip('b', 7, 1)]).map((item) => item.placement.start)).toEqual([0, 2]);
  });
});
