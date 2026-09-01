import { describe, expect, it } from 'vitest';

import type { TimelineClip } from '../../shared/desktop/dto';
import { repeatedFrameClipIds, timelineThroughEditCuts } from './timelineDisplayEvidence';

function clip(id: string, start: number, sourceIn: number, sourceOut: number): TimelineClip {
  return {
    id, name: id, capture_intent: null,
    material: { kind: 'asset', asset_id: 'asset', media_duration_seconds: 20 },
    placement: { start, duration: sourceOut - sourceIn, source_in: sourceIn, source_out: sourceOut, speed: 1, volume: 1, pan: 0, enabled: true },
    transform: { x: 0, y: 0, scale_x: 1, scale_y: 1, rotation: 0, opacity: 1 }, effects: [],
    transitions: { video_in: null, video_out: null, audio_in: null, audio_out: null }, text: null,
    metadata: {}, group_id: null, link_group_id: null, keyframes: [], speed_segments: [],
  };
}

describe('Timeline display evidence', () => {
  it('marks a cut through contiguous frames from one source', () => {
    expect(timelineThroughEditCuts([clip('a', 0, 0, 5), clip('b', 5, 5, 10)], 60)).toEqual([5]);
    expect(timelineThroughEditCuts([clip('a', 0, 0, 5), clip('b', 5, 6, 10)], 60)).toEqual([]);
  });

  it('marks every clip that reuses an overlapping source frame range', () => {
    expect([...repeatedFrameClipIds([clip('a', 0, 0, 5), clip('b', 5, 4, 8), clip('c', 9, 9, 11)])]).toEqual(['a', 'b']);
  });
});
