import { describe, expect, it } from 'vitest';

import type { TimelineClip } from '../../shared/desktop/dto';
import { timelineFilmstripTiles } from './timelineFilmstripGeometry';

function clip(overrides: Partial<TimelineClip> = {}): TimelineClip {
  return {
    id: 'clip',
    name: 'Clip',
    capture_intent: null,
    material: { kind: 'asset', asset_id: 'asset', media_duration_seconds: 40 },
    placement: {
      start: 10,
      duration: 8,
      source_in: 2,
      source_out: 10,
      speed: 1,
      reverse: false,
      frame_hold_source_time: null,
      volume: 1,
      pan: 0,
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
    ...overrides,
  };
}

describe('timelineFilmstripTiles', () => {
  it('uses distinct source frames across an expanded clip instead of stretching one poster frame', () => {
    const tiles = timelineFilmstripTiles({
      clip: clip(),
      clipLeftPx: 400,
      clipWidthPx: 640,
      trackHeightPx: 80,
      viewportStartPx: 0,
      viewportEndPx: 1_200,
      fps: 30,
      mode: 'frames',
    });

    expect(tiles.length).toBeGreaterThan(4);
    expect(tiles[0]?.sourceTime).toBe(2);
    expect(new Set(tiles.map((tile) => tile.sourceTime)).size).toBe(tiles.length);
    expect(tiles.at(-1)?.sourceTime).toBeLessThan(10);
  });

  it('returns only the padded tiles intersecting the visible timeline window', () => {
    const tiles = timelineFilmstripTiles({
      clip: clip(),
      clipLeftPx: 0,
      clipWidthPx: 4_000,
      trackHeightPx: 80,
      viewportStartPx: 1_600,
      viewportEndPx: 2_400,
      fps: 30,
      mode: 'frames',
    });

    expect(tiles.length).toBeLessThan(20);
    expect(tiles[0]!.leftPx).toBeLessThanOrEqual(1_600);
    expect(tiles.at(-1)!.leftPx + tiles.at(-1)!.widthPx).toBeGreaterThanOrEqual(2_400);
  });

  it('suppresses thumbnails for compact tracks and respects reverse playback', () => {
    expect(timelineFilmstripTiles({
      clip: clip(),
      clipLeftPx: 0,
      clipWidthPx: 640,
      trackHeightPx: 36,
      viewportStartPx: 0,
      viewportEndPx: 640,
      fps: 30,
      mode: 'frames',
    })).toEqual([]);

    const reverseClip = clip();
    const reverse = timelineFilmstripTiles({
      clip: { ...reverseClip, placement: { ...reverseClip.placement, reverse: true } },
      clipLeftPx: 0,
      clipWidthPx: 640,
      trackHeightPx: 80,
      viewportStartPx: 0,
      viewportEndPx: 640,
      fps: 30,
      mode: 'frames',
    });
    expect(reverse[0]?.sourceTime).toBe(10);
    expect(reverse.at(-1)!.sourceTime).toBeGreaterThan(2);
  });

  it('supports Premiere head, head-and-tail, and name-only display modes', () => {
    const base = {
      clip: clip(),
      clipLeftPx: 0,
      clipWidthPx: 640,
      trackHeightPx: 80,
      viewportStartPx: 0,
      viewportEndPx: 640,
      fps: 30,
    } as const;

    expect(timelineFilmstripTiles({ ...base, mode: 'none' })).toEqual([]);
    expect(timelineFilmstripTiles({ ...base, mode: 'head' }).map((tile) => tile.sourceTime)).toEqual([2]);
    expect(timelineFilmstripTiles({ ...base, mode: 'head_tail' }).map((tile) => tile.sourceTime)).toEqual([2, expect.closeTo(10, 1)]);
  });
});
