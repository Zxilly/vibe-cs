import { describe, expect, it } from 'vitest';

import type { Project, TimelineClip, TimelineTrack } from '../../shared/desktop/dto';
import { multicamAnglesAtTime } from './multicamEditing';

function angle(id: string, angle: number, enabled: boolean): TimelineClip {
  return {
    id, name: `Angle ${angle}`, capture_intent: null,
    material: { kind: 'asset', asset_id: `asset-${angle}`, media_duration_seconds: 10 },
    placement: { start: 0, duration: 10, source_in: 0, source_out: 10, speed: 1, reverse: false, frame_hold_source_time: null, volume: 1, pan: 0, enabled },
    transform: { x: 0, y: 0, scale_x: 1, scale_y: 1, rotation: 0, opacity: 1 }, effects: [],
    transitions: { video_in: null, video_out: null, audio_in: null, audio_out: null }, text: null,
    metadata: { multicam: { group_id: 'group', angle, angle_name: `Camera ${angle}`, sync_method: 'audio', switch_audio: true } },
    group_id: null, link_group_id: null, keyframes: [], speed_segments: [],
  };
}

function track(id: string, clip: TimelineClip, order: number): TimelineTrack {
  return { id, name: id, kind: 'video', order, muted: false, solo: false, volume: 1, pan: 0, keyframes: [], locked: false, hidden: false, clips: [clip] };
}

describe('multicam projection', () => {
  it('returns every camera covering the playhead while preserving one active angle', () => {
    const tracks = [track('v1', angle('a1', 1, false), 0), track('v2', angle('a2', 2, true), 1)];
    const project = { id: 'p', name: 'p', revision: 1, document: { width: 1920, height: 1080, fps: 60, duration_seconds: 10, story_track_id: 'v1', tracks, markers: [], settings: { source_demo_ids: [], ripple_sequence_markers: false, use_media_proxies: false } }, created_at: '', updated_at: '' } satisfies Project;
    expect(multicamAnglesAtTime(project, 5).map(({ angle, active, name }) => ({ angle, active, name }))).toEqual([
      { angle: 1, active: false, name: 'Camera 1' },
      { angle: 2, active: true, name: 'Camera 2' },
    ]);
    expect(multicamAnglesAtTime(project, 10)).toEqual([]);
  });
});
