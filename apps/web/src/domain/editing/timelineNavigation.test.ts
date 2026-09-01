import { describe, expect, it } from 'vitest';

import type { EditorMarker, TimelineClip, TimelineTrack } from '../../shared/desktop/dto';
import { adjacentMarker, adjacentTimelineTime, timelineEditPoints } from './timelineNavigation';

function clip(id: string, start: number, duration: number): TimelineClip {
  return {
    id, name: id, capture_intent: null, material: { kind: 'planned' },
    placement: { start, duration, source_in: 0, source_out: duration, speed: 1, volume: 1, pan: 0, enabled: true },
    transform: { x: 0, y: 0, scale_x: 1, scale_y: 1, rotation: 0, opacity: 1 },
    effects: [], transitions: { video_in: null, video_out: null, audio_in: null, audio_out: null }, text: null, metadata: {},
    group_id: null, link_group_id: null, keyframes: [], speed_segments: [],
  };
}

function track(id: string, clips: readonly TimelineClip[]): TimelineTrack {
  return { id, name: id, kind: 'video', order: 0, muted: false, solo: false, volume: 1, pan: 0, keyframes: [], locked: false, hidden: false, clips: [...clips] };
}

describe('Timeline navigation', () => {
  it('collects edit points from targeted tracks or every track', () => {
    const v1 = track('v1', [clip('a', 0, 5)]);
    const v2 = track('v2', [clip('b', 2, 6)]);
    expect(timelineEditPoints({ tracks: [v1, v2], targetTrackIds: new Set(['v1']), allTracks: false, duration: 10 }))
      .toEqual([0, 5, 10]);
    expect(timelineEditPoints({ tracks: [v1, v2], targetTrackIds: new Set(['v1']), allTracks: true, duration: 10 }))
      .toEqual([0, 2, 5, 8, 10]);
  });

  it('finds adjacent edit points and markers without wrapping', () => {
    expect(adjacentTimelineTime([0, 2, 5], 2, 1, 60)).toBe(5);
    expect(adjacentTimelineTime([0, 2, 5], 2, -1, 60)).toBe(0);
    expect(adjacentTimelineTime([0, 2, 5], 5, 1, 60)).toBeNull();
    const markers: EditorMarker[] = [
      { id: 'm2', time: 4, label: 'M2', color: '#FFFFFF' },
      { id: 'm1', time: 1, label: 'M1', color: '#FFFFFF' },
    ];
    expect(adjacentMarker(markers, 1, 1, 60)?.id).toBe('m2');
    expect(adjacentMarker(markers, 4, -1, 60)?.id).toBe('m1');
  });
});
