import { describe, expect, it } from 'vitest';

import type { TimelineClip, TimelineTrack } from '../../shared/desktop/dto';
import { timelineTrackSelection } from './timelineTrackSelection';

function clip(id: string, start: number): TimelineClip {
  return {
    id,
    name: id,
    capture_intent: null,
    material: { kind: 'planned' },
    placement: { start, duration: 5, source_in: 0, source_out: 5, speed: 1, volume: 1, enabled: true },
    transform: { x: 0, y: 0, scale_x: 1, scale_y: 1, rotation: 0, opacity: 1 },
    effects: [], transitions: { video_in: null, video_out: null, audio_in: null, audio_out: null }, text: null, metadata: {},
    group_id: null, link_group_id: null, keyframes: [], speed_segments: [],
  };
}

function track(id: string, order: number): TimelineTrack {
  return { id, name: id, kind: 'video', order, muted: false, locked: false, hidden: false, clips: [clip(`${id}-a`, 0), clip(`${id}-b`, 5), clip(`${id}-c`, 10)] };
}

describe('Timeline Track Select', () => {
  it('selects the clicked clip and everything forward on one track', () => {
    expect(timelineTrackSelection({
      tracks: [track('v1', 0), track('v2', 1)],
      trackId: 'v1',
      timelineTime: 7,
      direction: 'forward',
      allTracks: false,
    })).toEqual(['v1-b', 'v1-c']);
  });

  it('selects backward across every track while preserving track order', () => {
    expect(timelineTrackSelection({
      tracks: [track('v2', 1), track('v1', 0)],
      trackId: 'v1',
      timelineTime: 7,
      direction: 'backward',
      allTracks: true,
    })).toEqual(['v1-a', 'v1-b', 'v2-a', 'v2-b']);
  });
});
