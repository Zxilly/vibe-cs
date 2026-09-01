import { describe, expect, it } from 'vitest';

import type { TimelineClip } from '../../shared/desktop/dto';
import {
  restoreTimelineClipSync,
  timelineClipOutOfSyncFrames,
  unlinkTimelineClipWithSyncReference,
} from './timelineSyncStatus';

function clip(id: string, start: number): TimelineClip {
  return {
    id, name: id, capture_intent: null, material: { kind: 'planned' },
    placement: { start, duration: 2, source_in: 0, source_out: 2, speed: 1, volume: 1, pan: 0, enabled: true },
    transform: { x: 0, y: 0, scale_x: 1, scale_y: 1, rotation: 0, opacity: 1 },
    effects: [], transitions: { video_in: null, video_out: null, audio_in: null, audio_out: null }, text: null,
    metadata: {}, group_id: null, link_group_id: 'link', keyframes: [], speed_segments: [],
  };
}

describe('Timeline out-of-sync status', () => {
  it('measures relative displacement after unlink and restores the selected side', () => {
    const video = unlinkTimelineClipWithSyncReference(clip('video', 5));
    const audio = unlinkTimelineClipWithSyncReference(clip('audio', 5));
    const moved = { ...video, placement: { ...video.placement, start: 5 + 3 / 60 } };
    expect(timelineClipOutOfSyncFrames(moved, [moved, audio], 60)).toBe(3);
    expect(timelineClipOutOfSyncFrames(audio, [moved, audio], 60)).toBe(-3);
    expect(restoreTimelineClipSync(moved, [moved, audio], 60).placement.start).toBe(5);
  });
});
