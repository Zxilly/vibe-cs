import { describe, expect, it } from 'vitest';

import type { Project, TimelineClip, TimelineTrack } from '../../shared/desktop/dto';
import { evaluateTimelineAudio, timelineAudioPool } from './TimelineAudioMonitor';
import { evaluateTimelineAudioMix, timelineTrackAudible } from './timelineAudioMix';
import { advanceTimelineTransport, transportReachedBoundary } from './TimelineProgramMonitor';

function clip(id: string, start: number, duration = 4): TimelineClip {
  return {
    id,
    name: id,
    capture_intent: null,
    material: { kind: 'asset', asset_id: `asset-${id}`, media_duration_seconds: 30 },
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
  };
}

function project(audioTracks: TimelineTrack[]): Project {
  const storyId = '00000000-0000-4000-8000-000000000001';
  return {
    id: '00000000-0000-4000-8000-000000000002',
    name: 'Audio preview',
    revision: 1,
    document: {
      width: 1920,
      height: 1080,
      fps: 60,
      duration_seconds: 12,
      story_track_id: storyId,
      tracks: [{
        id: storyId,
        name: 'Story',
        kind: 'video',
        order: 0,
        muted: false,
        solo: false,
        volume: 1,
        pan: 0,
        keyframes: [],
        locked: false,
        hidden: false,
        clips: [],
      }, ...audioTracks],
      markers: [],
      settings: { source_demo_ids: [] },
    },
    created_at: '2026-08-30T00:00:00Z',
    updated_at: '2026-08-30T00:00:00Z',
  };
}

describe('Timeline audio monitor', () => {
  it('advances forward and reverse audio-only transport inside project bounds', () => {
    expect(advanceTimelineTransport(1, 0.5, 2, 8)).toBe(2);
    expect(advanceTimelineTransport(1, 2, -1, 8)).toBe(0);
    expect(advanceTimelineTransport(7.5, 1, 1, 8)).toBe(8);
    expect(transportReachedBoundary(0, 1, 8)).toBe(false);
    expect(transportReachedBoundary(0, -1, 8)).toBe(true);
    expect(transportReachedBoundary(8, 1, 8)).toBe(true);
  });

  it('keeps active audio plus one warm neighbour on each side per A track', () => {
    const track: TimelineTrack = {
      id: '00000000-0000-4000-8000-000000000003',
      name: 'A1',
      kind: 'audio',
      order: 1,
      muted: false,
      solo: false,
      volume: 1,
      pan: 0,
      keyframes: [],
      locked: false,
      hidden: false,
      clips: [clip('a', 0), clip('b', 4), clip('c', 8)],
    };

    expect(timelineAudioPool(project([track]), 5).map((item) => [item.clip.id, item.active])).toEqual([
      ['b', true],
      ['a', false],
      ['c', false],
    ]);
  });

  it('keeps output-disabled audio tracks out of the monitor pool', () => {
    const track: TimelineTrack = {
      id: '00000000-0000-4000-8000-000000000004',
      name: 'Hidden A1',
      kind: 'audio',
      order: 1,
      muted: false,
      solo: false,
      volume: 1,
      pan: 0,
      keyframes: [],
      locked: false,
      hidden: true,
      clips: [clip('hidden', 0)],
    };

    expect(timelineAudioPool(project([track]), 1)).toEqual([]);
  });

  it('evaluates the same gain keyframe and fade envelope as Program audio', () => {
    const source = {
      ...clip('fade', 0, 4),
      placement: { ...clip('fade', 0, 4).placement, volume: 2 },
      transitions: {
        video_in: null,
        video_out: null,
        audio_in: { kind: 'constant_power' as const, duration_seconds: 2 },
        audio_out: { kind: 'constant_power' as const, duration_seconds: 2 },
      },
      keyframes: [{ id: 'volume', time: 1, property: 'volume' as const, value: 1, interpolation: 'linear' as const, in_tangent: 0, out_tangent: 0  }],
    };

    expect(evaluateTimelineAudio(source, 0)).toEqual({ canonicalVolume: 1, fadeFactor: 0, outputVolume: 0 });
    expect(evaluateTimelineAudio(source, 1)).toMatchObject({ canonicalVolume: 1 });
    expect(evaluateTimelineAudio(source, 1).fadeFactor).toBeCloseTo(Math.SQRT1_2);
    expect(evaluateTimelineAudio(source, 1).outputVolume).toBeCloseTo(Math.SQRT1_2);
    expect(evaluateTimelineAudio(source, 4)).toEqual({ canonicalVolume: 1, fadeFactor: 0, outputVolume: 0 });
  });

  it('applies Solo, track automation and clip plus track pan to Program audio', () => {
    const first: TimelineTrack = {
      id: '00000000-0000-4000-8000-000000000005',
      name: 'A1',
      kind: 'audio',
      order: 1,
      muted: false,
      solo: true,
      volume: 0.5,
      pan: 0.25,
      keyframes: [{ id: 'track-volume', time: 2, property: 'volume', value: 1, interpolation: 'linear' as const, in_tangent: 0, out_tangent: 0  }],
      locked: false,
      hidden: false,
      clips: [],
    };
    const second = { ...first, id: '00000000-0000-4000-8000-000000000006', name: 'A2', solo: false };
    const current = project([first, second]);
    expect(timelineTrackAudible(current, first)).toBe(true);
    expect(timelineTrackAudible(current, second)).toBe(false);

    const source = { ...clip('mix', 0), placement: { ...clip('mix', 0).placement, volume: 2, pan: -0.5 } };
    expect(evaluateTimelineAudioMix(first, source, 1)).toMatchObject({
      clipVolume: 2,
      trackVolume: 1,
      clipPan: -0.5,
      trackPan: 0.25,
      outputVolume: 2,
    });
  });
});
