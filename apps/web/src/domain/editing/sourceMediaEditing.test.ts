import { describe, expect, it } from 'vitest';

import type { EditingDocument, MediaAsset, TimelineClip, TimelineTrack } from '../../shared/desktop/dto';
import { planSourceMediaEdit, replaceTimelineClipSource, resolveSourceMediaFit } from './sourceMediaEditing';

function clip(id: string, start: number, duration: number): TimelineClip {
  return {
    id,
    name: id,
    capture_intent: null,
    material: { kind: 'asset', asset_id: id, media_duration_seconds: duration },
    placement: { start, duration, source_in: 0, source_out: duration, speed: 1, volume: 1, pan: 0, enabled: true },
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
  return { id, name: id, kind, order: 0, muted: false, solo: false, volume: 1, pan: 0, keyframes: [], locked: false, hidden: false, clips: [...clips] };
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
  it('resolves all Premiere four-point Fit Clip choices', () => {
    const input = { sourceRange: { sourceIn: 2, sourceOut: 8 }, sequenceRange: { start: 10, end: 14 }, mediaDuration: 12 };
    expect(resolveSourceMediaFit({ ...input, mode: 'fit_to_fill' })).toEqual({ sourceRange: input.sourceRange, editTimeSeconds: 10, timelineDurationSeconds: 4, speed: 1.5 });
    expect(resolveSourceMediaFit({ ...input, mode: 'trim_head' })).toMatchObject({ sourceRange: { sourceIn: 4, sourceOut: 8 }, editTimeSeconds: 10, speed: 1 });
    expect(resolveSourceMediaFit({ ...input, mode: 'trim_tail' })).toMatchObject({ sourceRange: { sourceIn: 2, sourceOut: 6 }, editTimeSeconds: 10, speed: 1 });
    expect(resolveSourceMediaFit({ ...input, mode: 'ignore_sequence_in' })).toMatchObject({ editTimeSeconds: 8, timelineDurationSeconds: 6 });
    expect(resolveSourceMediaFit({ ...input, mode: 'ignore_sequence_out' })).toMatchObject({ editTimeSeconds: 10, timelineDurationSeconds: 6 });
  });

  it('replaces source media while preserving the Timeline edit and authored attributes', () => {
    const original: TimelineClip = {
      ...clip('replace-me', 3, 2),
      placement: { ...clip('replace-me', 3, 2).placement, speed: 1.5, source_out: 3 },
      transform: { x: 20, y: 10, scale_x: 1.2, scale_y: 1.2, rotation: 5, opacity: 0.8 },
      effects: [{ id: 'fx', kind: 'blur', enabled: true, parameters: { radius: 4 } }],
      transitions: { video_in: { kind: 'fade', duration_seconds: 0.5 }, video_out: null, audio_in: null, audio_out: null },
      keyframes: [{ id: 'opacity', time: 1, property: 'opacity', value: 0.5, interpolation: 'linear' as const, in_tangent: 0, out_tangent: 0  }],
    };
    const replacement = replaceTimelineClipSource({
      clip: original,
      track: VIDEO,
      asset: { ...ASSET, duration_seconds: 12 },
      sourceRange: { sourceIn: 4, sourceOut: 9 },
    });

    expect(replacement).toMatchObject({
      id: original.id,
      name: ASSET.name,
      material: { kind: 'asset', asset_id: ASSET.id, media_duration_seconds: 12 },
      placement: { start: 3, duration: 2, speed: 1.5, source_in: 4, source_out: 7 },
      transform: original.transform,
      effects: original.effects,
      transitions: original.transitions,
      keyframes: original.keyframes,
    });
  });

  it('rejects incompatible or insufficient replacement sources', () => {
    const target = clip('replace-me', 0, 5);
    expect(replaceTimelineClipSource({ clip: target, track: VIDEO, asset: ASSET, sourceRange: { sourceIn: 0, sourceOut: 4 } })).toBeNull();
    expect(replaceTimelineClipSource({ clip: target, track: VIDEO, asset: { ...ASSET, kind: 'audio' }, sourceRange: { sourceIn: 0, sourceOut: 4 } })).toBeNull();
    expect(replaceTimelineClipSource({ clip: target, track: { ...VIDEO, locked: true }, asset: { ...ASSET, duration_seconds: 10 }, sourceRange: { sourceIn: 0, sourceOut: 10 } })).toBeNull();
  });

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
