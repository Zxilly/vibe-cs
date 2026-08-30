import { describe, expect, it } from 'vitest';

import type { EditingDocument, MediaAsset, TimelineClip, TimelineTrack } from '../../shared/desktop/dto';
import { planSourceMediaEdit } from './sourceMediaEditing';

function clip(id: string, start: number, duration: number): TimelineClip {
  return {
    id,
    name: id,
    capture_intent: null,
    material: { kind: 'asset', asset_id: id, media_duration_seconds: duration },
    placement: { start, duration, source_in: 0, source_out: duration, speed: 1, volume: 1, enabled: true },
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

function track(id: string, kind: TimelineTrack['kind'], clips: readonly TimelineClip[] = []): TimelineTrack {
  return { id, name: id, kind, order: 0, muted: false, locked: false, hidden: false, clips: [...clips] };
}

const STORY = track('story', 'video', [clip('story-old', 0, 10)]);
const VIDEO = track('video', 'video', [clip('video-old', 0, 10)]);
const AUDIO = track('audio', 'audio', [clip('audio-old', 0, 10)]);
const DOCUMENT: EditingDocument = {
  width: 1920,
  height: 1080,
  fps: 60,
  duration_seconds: 10,
  story_track_id: STORY.id,
  tracks: [STORY, VIDEO, AUDIO],
  markers: [],
  settings: { source_demo_ids: [] },
};
const ASSET: MediaAsset = {
  id: 'asset-av',
  project_id: 'project',
  path: 'D:\\media\\av.mp4',
  name: 'AV source',
  kind: 'video',
  duration_seconds: 4,
  width: 1920,
  height: 1080,
  file_size: 4_096,
  has_audio: true,
  proxy_path: null,
  proxy_status: { status: 'not_requested' },
  waveform: [0.2, 0.8],
  metadata_status: { status: 'ready' },
  created_at: '2026-08-31T00:00:00Z',
};

function ids() {
  let next = 0;
  return () => `generated-${++next}`;
}

describe('source media editing', () => {
  it('keeps Story AV in one compound clip and ripples once', () => {
    const plan = planSourceMediaEdit({
      document: DOCUMENT,
      asset: ASSET,
      sourcePatch: { video: true, audio: true },
      tracks: { videoTrack: STORY, audioTrack: null, embeddedAudio: true },
      mode: 'insert',
      editTimeSeconds: 0,
      newAudioTrackName: 'Audio 2',
      createId: ids(),
    });

    expect(plan?.operations).toHaveLength(1);
    expect(plan?.operations[0]).toMatchObject({
      op: 'replace_track_clips',
      track_id: STORY.id,
      clips: [
        { name: 'AV source', link_group_id: null, placement: { start: 0, duration: 4, volume: 1 } },
        { id: 'story-old', placement: { start: 4 } },
      ],
    });
  });

  it('splits free-track AV into linked clips without duplicate video audio', () => {
    const plan = planSourceMediaEdit({
      document: DOCUMENT,
      asset: ASSET,
      sourcePatch: { video: true, audio: true },
      tracks: { videoTrack: VIDEO, audioTrack: AUDIO, embeddedAudio: false },
      mode: 'insert',
      editTimeSeconds: 12,
      sourceRange: { sourceIn: 1, sourceOut: 3 },
      newAudioTrackName: 'Audio 2',
      createId: ids(),
    });

    expect(plan?.operations).toHaveLength(2);
    const video = plan?.operations[0]?.op === 'replace_track_clips' ? plan.operations[0].clips.at(-1) : null;
    const audio = plan?.operations[1]?.op === 'replace_track_clips' ? plan.operations[1].clips.at(-1) : null;
    expect(video?.placement).toMatchObject({ start: 12, duration: 2, source_in: 1, source_out: 3, volume: 0 });
    expect(audio?.placement).toMatchObject({ start: 12, duration: 2, source_in: 1, source_out: 3, volume: 1 });
    expect(video?.link_group_id).toBeTruthy();
    expect(audio?.link_group_id).toBe(video?.link_group_id);
  });

  it('overwrites both patched free tracks with the same source interval', () => {
    const plan = planSourceMediaEdit({
      document: DOCUMENT,
      asset: ASSET,
      sourcePatch: { video: true, audio: true },
      tracks: { videoTrack: VIDEO, audioTrack: AUDIO, embeddedAudio: false },
      mode: 'overwrite',
      editTimeSeconds: 3,
      sourceRange: { sourceIn: 1, sourceOut: 3 },
      newAudioTrackName: 'Audio 2',
      createId: ids(),
    });

    for (const operation of plan?.operations ?? []) {
      if (operation.op !== 'replace_track_clips') continue;
      expect(operation.clips.map((item) => item.placement)).toEqual([
        expect.objectContaining({ start: 0, duration: 3, source_in: 0, source_out: 3 }),
        expect.objectContaining({ start: 3, duration: 2, source_in: 1, source_out: 3 }),
        expect.objectContaining({ start: 5, duration: 5, source_in: 5, source_out: 10 }),
      ]);
    }
  });
});
