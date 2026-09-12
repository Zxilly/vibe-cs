import type { Project, ProjectDeliveryGate, TimelineClip } from '../shared/desktop/dto';

const DEMO_ID = '3f2c9a10-11d4-4a6e-9d21-6b0f1a2c3d41';
const STORY_ID = '80000000-0000-4000-8000-000000000001';

const clips: TimelineClip[] = Array.from({ length: 30 }, (_, index) => ({
  id: `80000000-0000-4000-8000-${String(index + 10).padStart(12, '0')}`,
  name: `Mirage R${Math.floor(index / 2) + 1} · s1mple`,
  capture_intent: {
    demo_id: DEMO_ID, highlight_id: null, player_id: '76561197960266729',
    start_tick: 10_000 + Math.floor(index / 2) * 7_400 + index % 2 * 512, end_tick: 10_384 + Math.floor(index / 2) * 7_400 + index % 2 * 512,
    pre_roll_seconds: 0, post_roll_seconds: 0, victim_pov: false,
    camera_style: 'pov', presentation: null,
  },
  material: { kind: 'planned' },
  placement: {
    start: index * 6, duration: 6, source_in: 0, source_out: 6, speed: 1,
    reverse: false, frame_hold_source_time: null, volume: 1, pan: 0, enabled: true,
  },
  transform: { x: 0, y: 0, scale_x: 1, scale_y: 1, rotation: 0, opacity: 1 },
  effects: [], transitions: { video_in: null, video_out: null, audio_in: null, audio_out: null },
  text: null, metadata: {}, group_id: null, link_group_id: null, keyframes: [], speed_segments: [],
}));

export const PREVIEW_PROJECT: Project = {
  id: '80000000-0000-4000-8000-000000000000',
  name: 's1mple · Mirage 集锦',
  revision: 12,
  created_at: '2026-09-05T08:00:00Z',
  updated_at: '2026-09-12T08:00:00Z',
  document: {
    width: 1920, height: 1080, fps: 60, duration_seconds: 180,
    story_track_id: STORY_ID,
    tracks: [{
      id: STORY_ID, name: 'Story', kind: 'video', order: 0, muted: false,
      solo: false, volume: 1, pan: 0, keyframes: [], locked: false, hidden: false, clips,
    }],
    markers: [],
    settings: { source_demo_ids: [DEMO_ID], ripple_sequence_markers: true, use_media_proxies: false },
  },
};

export const PREVIEW_DELIVERY_GATE: ProjectDeliveryGate = {
  project_id: PREVIEW_PROJECT.id,
  revision: PREVIEW_PROJECT.revision,
  ready: false,
  blockers: clips.map((clip) => ({ clip_id: clip.id, state: 'unrecorded' })),
};
