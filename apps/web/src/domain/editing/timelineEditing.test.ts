import { describe, expect, it } from 'vitest';

import type { MediaAsset, TimelineClip } from '../../shared/desktop/dto';
import {
  deleteRippleClip,
  deleteRippleClips,
  extractTimelineRange,
  insertRippleClipAtTime,
  liftTimelineRange,
  moveRippleClip,
  moveRippleClipGroup,
  moveFreeClipGroup,
  overwriteClipsAtTime,
  placeFreeClipAtTime,
  splitRippleClip,
  timelineClipsInRange,
  timelineClipFromMediaAsset,
  trimRippleClip,
  trimRippleClipGroup,
  trimFreeClipGroup,
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
    transitions: { video_in: null, video_out: null, audio_in: null, audio_out: null },
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
  it('reorders by the movement-facing edge and closes every gap', () => {
    const moved = moveRippleClip(CLIPS, 'a', 24);
    expect(moved.map((item) => item.id)).toEqual(['b', 'c', 'a']);
    expect(moved.map((item) => item.placement.start)).toEqual([0, 10, 20]);
  });

  it('moves a longer Story clip before a shorter first clip at the zero boundary', () => {
    const clips = [clip('short', 0, 4), clip('long', 4, 10), clip('tail', 14, 6)];
    const moved = moveRippleClip(clips, 'long', 0);

    expect(moved.map((item) => item.id)).toEqual(['long', 'short', 'tail']);
    expect(moved.map((item) => item.placement.start)).toEqual([0, 10, 14]);
  });

  it('moves selected Story clips as one ordered ripple group', () => {
    const moved = moveRippleClipGroup(CLIPS, new Set(['a', 'b']), 'b', 26);
    expect(moved.map((item) => item.id)).toEqual(['c', 'a', 'b']);
    expect(moved.map((item) => item.placement.start)).toEqual([0, 10, 20]);
  });

  it('moves free-track clips by one frame-snapped delta without changing gaps', () => {
    const moved = moveFreeClipGroup(CLIPS, new Set(['a', 'c']), 'c', 25.019, 60);
    expect(moved.map((item) => item.id)).toEqual(['a', 'b', 'c']);
    expect(moved[0]?.placement.start).toBeCloseTo(5.016_666_667);
    expect(moved[1]?.placement.start).toBe(10);
    expect(moved[2]?.placement.start).toBeCloseTo(25.016_666_667);
  });

  it('ripples following placements after a trim', () => {
    const trimmed = trimRippleClip(CLIPS, { ...CLIPS[1]!, placement: { ...CLIPS[1]!.placement, duration: 5, source_out: 5 } });
    expect(trimmed.map((item) => item.placement.start)).toEqual([0, 10, 15]);
  });

  it('keeps the original Story origin when trimming its first clip start', () => {
    const replacement = {
      ...CLIPS[0]!,
      placement: { ...CLIPS[0]!.placement, start: 2, duration: 8, source_in: 2 },
    };
    const trimmed = trimRippleClip(CLIPS, replacement);

    expect(trimmed.map((item) => item.placement.start)).toEqual([0, 8, 18]);
    expect(trimmed[0]?.placement).toMatchObject({ duration: 8, source_in: 2 });
  });

  it('trims selected Story clips with one shared delta and one reflow', () => {
    const trimmed = trimRippleClipGroup(CLIPS, new Set(['a', 'b']), 'start', 2, 60);
    expect(trimmed.map((item) => item.placement.start)).toEqual([0, 8, 16]);
    expect(trimmed[0]?.placement).toMatchObject({ duration: 8, source_in: 2 });
    expect(trimmed[1]?.placement).toMatchObject({ duration: 8, source_in: 2 });
  });

  it('trims selected free clips without moving unselected placements', () => {
    const trimmed = trimFreeClipGroup(CLIPS, new Set(['a', 'b']), 'end', -2, 60);
    expect(trimmed.map((item) => item.placement.start)).toEqual([0, 10, 20]);
    expect(trimmed[0]?.placement).toMatchObject({ duration: 8, source_out: 8 });
    expect(trimmed[1]?.placement).toMatchObject({ duration: 8, source_out: 8 });
  });

  it('splits at the playhead while preserving source coverage and total duration', () => {
    const split = splitRippleClip(CLIPS, 'b', 14, 'b-right');
    expect(split.map((item) => item.id)).toEqual(['a', 'b', 'b-right', 'c']);
    expect(split.map((item) => item.placement.start)).toEqual([0, 10, 14, 20]);
    expect(split[1]?.placement).toMatchObject({ duration: 4, source_in: 0, source_out: 4 });
    expect(split[2]?.placement).toMatchObject({ duration: 6, source_in: 4, source_out: 10 });
  });

  it('splits a time-remapped clip with independently valid local speed sections', () => {
    const remapped = {
      ...CLIPS[1]!,
      speed_segments: [
        { id: 'slow', start: 0, end: 4, speed: 0.5 },
        { id: 'fast', start: 4, end: 10, speed: 4 / 3 },
      ],
    };
    const split = splitRippleClip([CLIPS[0]!, remapped, CLIPS[2]!], 'b', 16, 'b-right');

    expect(split[1]?.placement).toMatchObject({ duration: 6, source_in: 0 });
    expect(split[1]?.placement.source_out).toBeCloseTo(14 / 3);
    expect(split[1]?.placement.speed).toBeCloseTo(7 / 9);
    expect(split[1]?.speed_segments).toEqual([
      { id: 'slow', start: 0, end: 4, speed: 0.5 },
      { id: 'fast', start: 4, end: 6, speed: 4 / 3 },
    ]);
    expect(split[2]?.placement).toMatchObject({ duration: 4, source_out: 10 });
    expect(split[2]?.placement.source_in).toBeCloseTo(14 / 3);
    expect(split[2]?.placement.speed).toBeCloseTo(4 / 3);
    expect(split[2]?.speed_segments).toEqual([{ id: 'fast', start: 0, end: 4, speed: 4 / 3 }]);
  });

  it('deletes and closes the removed duration', () => {
    const deleted = deleteRippleClip(CLIPS, 'b');
    expect(deleted.map((item) => item.id)).toEqual(['a', 'c']);
    expect(deleted.map((item) => item.placement.start)).toEqual([0, 10]);
  });

  it('deletes multiple Story clips and closes every resulting gap', () => {
    const deleted = deleteRippleClips(CLIPS, new Set(['a', 'c']));
    expect(deleted.map((item) => item.id)).toEqual(['b']);
    expect(deleted[0]?.placement.start).toBe(0);
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

  it('creates a source-range clip while retaining the full master-media duration', () => {
    const asset: MediaAsset = {
      id: 'asset-range',
      project_id: 'project',
      path: 'D:\\media\\range.mp4',
      name: 'Source range',
      kind: 'video',
      duration_seconds: 10,
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

    expect(timelineClipFromMediaAsset(asset, 'range-clip', { sourceIn: 2, sourceOut: 5 })).toMatchObject({
      material: { kind: 'asset', asset_id: 'asset-range', media_duration_seconds: 10 },
      placement: { duration: 3, source_in: 2, source_out: 5, speed: 1 },
    });
  });

  it('creates a five-second canonical still-image clip when the source has no duration', () => {
    const image: MediaAsset = {
      id: 'asset-image',
      project_id: 'project',
      path: 'D:\\media\\title.png',
      name: 'Title card',
      kind: 'image/png',
      duration_seconds: 0.04,
      width: 1920,
      height: 1080,
      file_size: 1_024,
      has_audio: false,
      proxy_path: null,
      proxy_status: { status: 'not_requested' },
      waveform: null,
      metadata_status: { status: 'ready' },
      created_at: '2026-08-29T00:00:00Z',
    };

    expect(timelineClipFromMediaAsset(image, 'image-clip')).toMatchObject({
      material: { kind: 'asset', asset_id: 'asset-image', media_duration_seconds: 5 },
      placement: { duration: 5, source_in: 0, source_out: 5, speed: 1 },
      metadata: { media_asset_id: 'asset-image', media_kind: 'image/png' },
    });
  });

  it('overwrites a same-clip interval without moving the surviving tail', () => {
    const inserted = clip('inserted', 0, 6);
    const overwritten = overwriteClipsAtTime(CLIPS, inserted, 12, 'b-tail');

    expect(overwritten.map((item) => item.id)).toEqual(['a', 'b', 'inserted', 'b-tail', 'c']);
    expect(overwritten.map((item) => item.placement.start)).toEqual([0, 10, 12, 18, 20]);
    expect(overwritten[1]?.placement).toMatchObject({ duration: 2, source_in: 0, source_out: 2 });
    expect(overwritten[3]?.placement).toMatchObject({ duration: 2, source_in: 8, source_out: 10 });
  });

  it('overwrites across clip boundaries while preserving the later timeline', () => {
    const inserted = clip('inserted', 0, 12);
    const overwritten = overwriteClipsAtTime(CLIPS, inserted, 4, 'b-tail');

    expect(overwritten.map((item) => item.id)).toEqual(['a', 'inserted', 'b', 'c']);
    expect(overwritten.map((item) => item.placement.start)).toEqual([0, 4, 16, 20]);
    expect(overwritten[0]?.placement).toMatchObject({ duration: 4, source_in: 0, source_out: 4 });
    expect(overwritten[2]?.placement).toMatchObject({ start: 16, duration: 4, source_in: 6, source_out: 10 });
  });

  it('extracts a Story range and closes the removed interval', () => {
    const extracted = extractTimelineRange(CLIPS, 4, 16, 'b-tail');

    expect(extracted.map((item) => item.id)).toEqual(['a', 'b', 'c']);
    expect(extracted.map((item) => item.placement.start)).toEqual([0, 4, 8]);
    expect(extracted[0]?.placement).toMatchObject({ duration: 4, source_in: 0, source_out: 4 });
    expect(extracted[1]?.placement).toMatchObject({ duration: 4, source_in: 6, source_out: 10 });
  });

  it('lifts a free-track range without moving later placements', () => {
    const lifted = liftTimelineRange(CLIPS, 4, 16, 'b-tail');

    expect(lifted.map((item) => item.id)).toEqual(['a', 'b', 'c']);
    expect(lifted.map((item) => item.placement.start)).toEqual([0, 16, 20]);
  });

  it('copies only the intersecting source slices for Lift and Extract clipboard content', () => {
    const copied = timelineClipsInRange(CLIPS, 4, 16);
    expect(copied.map((item) => item.placement)).toEqual([
      expect.objectContaining({ start: 4, duration: 6, source_in: 4, source_out: 10 }),
      expect.objectContaining({ start: 10, duration: 6, source_in: 0, source_out: 6 }),
    ]);
  });

  it('extracts a free-positioned range while preserving gaps outside the removed interval', () => {
    const free = [
      { ...CLIPS[0]!, placement: { ...CLIPS[0]!.placement, start: 2, duration: 4, source_out: 4 } },
      { ...CLIPS[1]!, placement: { ...CLIPS[1]!.placement, start: 10, duration: 8, source_out: 8 } },
      { ...CLIPS[2]!, placement: { ...CLIPS[2]!.placement, start: 24, duration: 6, source_out: 6 } },
    ];

    const extracted = extractTimelineRange(free, 12, 16, 'b-tail');
    expect(extracted.map((item) => item.placement)).toEqual([
      expect.objectContaining({ start: 2, duration: 4 }),
      expect.objectContaining({ start: 10, duration: 2, source_in: 0, source_out: 2 }),
      expect.objectContaining({ start: 12, duration: 2, source_in: 6, source_out: 8 }),
      expect.objectContaining({ start: 20, duration: 6 }),
    ]);
  });

  it('places one imported clip on a free track without moving existing clips', () => {
    const inserted = placeFreeClipAtTime(CLIPS, clip('music', 0, 6), 4);

    expect(inserted.map((item) => [item.id, item.placement.start])).toEqual([
      ['a', 0],
      ['music', 4],
      ['b', 10],
      ['c', 20],
    ]);
  });
});
