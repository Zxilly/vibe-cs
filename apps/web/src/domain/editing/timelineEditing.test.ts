import { describe, expect, it } from 'vitest';

import type { MediaAsset, TimelineClip } from '../../shared/desktop/dto';
import {
  deleteRippleClip,
  insertRippleClipAtTime,
  moveRippleClip,
  splitRippleClip,
  timelineClipFromMediaAsset,
  trimRippleClip,
} from './timelineEditing';

function clip(id: string, start: number, duration = 10): TimelineClip {
  return {
    id,
    name: id,
    capture_intent: null,
    material: { kind: 'asset', asset_id: 'asset', media_duration_seconds: 60 },
    placement: {
      start,
      duration,
      source_in: 0,
      source_out: duration,
      speed: 1,
      volume: 1,
      enabled: true,
    },
    transform: { x: 0, y: 0, scale_x: 1, scale_y: 1, rotation: 0, opacity: 1 },
    effects: [],
    transition_in: null,
    transition_out: null,
    text: null,
    metadata: {},
    group_id: null,
    link_group_id: null,
    keyframes: [],
    speed_segments: [],
  };
}

const CLIPS = [clip('a', 0), clip('b', 10), clip('c', 20)];

describe('ripple Story Track edits', () => {
  it('reorders by the dragged clip centre and closes every gap', () => {
    const moved = moveRippleClip(CLIPS, 'a', 24);
    expect(moved.map((item) => item.id)).toEqual(['b', 'c', 'a']);
    expect(moved.map((item) => item.placement.start)).toEqual([0, 10, 20]);
  });

  it('ripples following placements after a trim', () => {
    const trimmed = trimRippleClip(CLIPS, { ...CLIPS[1]!, placement: { ...CLIPS[1]!.placement, duration: 5, source_out: 5 } });
    expect(trimmed.map((item) => item.placement.start)).toEqual([0, 10, 15]);
  });

  it('splits at the playhead while preserving source coverage and total duration', () => {
    const split = splitRippleClip(CLIPS, 'b', 14, 'b-right');
    expect(split.map((item) => item.id)).toEqual(['a', 'b', 'b-right', 'c']);
    expect(split.map((item) => item.placement.start)).toEqual([0, 10, 14, 20]);
    expect(split[1]?.placement).toMatchObject({ duration: 4, source_in: 0, source_out: 4 });
    expect(split[2]?.placement).toMatchObject({ duration: 6, source_in: 4, source_out: 10 });
  });

  it('deletes and closes the removed duration', () => {
    const deleted = deleteRippleClip(CLIPS, 'b');
    expect(deleted.map((item) => item.id)).toEqual(['a', 'c']);
    expect(deleted.map((item) => item.placement.start)).toEqual([0, 10]);
  });

  it('inserts a full media asset at the playhead and ripples the split tail', () => {
    const asset: MediaAsset = {
      id: 'asset-new',
      project_id: 'project',
      path: 'D:\\media\\new.mp4',
      name: 'New angle',
      kind: 'video',
      duration_seconds: 6,
      width: 1920,
      height: 1080,
      file_size: 1_024,
      has_audio: true,
      proxy_path: null,
      proxy_status: { status: 'not_requested' },
      waveform: null,
      metadata_status: { status: 'ready' },
      created_at: '2026-08-29T00:00:00Z',
    };
    const inserted = insertRippleClipAtTime(
      CLIPS,
      timelineClipFromMediaAsset(asset, 'inserted'),
      14,
      'b-tail',
    );

    expect(inserted.map((item) => item.id)).toEqual(['a', 'b', 'inserted', 'b-tail', 'c']);
    expect(inserted.map((item) => item.placement.start)).toEqual([0, 10, 14, 20, 26]);
    expect(inserted[1]?.placement.duration).toBe(4);
    expect(inserted[2]).toMatchObject({
      name: 'New angle',
      material: { kind: 'asset', asset_id: 'asset-new', media_duration_seconds: 6 },
      placement: { start: 14, duration: 6, source_in: 0, source_out: 6 },
    });
    expect(inserted[3]?.placement).toMatchObject({ duration: 6, source_in: 4, source_out: 10 });
  });
});
