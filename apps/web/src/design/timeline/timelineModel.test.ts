import { describe, expect, it } from 'vitest';

import { createLinearTimeline, createSampleTimeline } from './sampleTimeline';
import {
  clipAt,
  clipContains,
  clipEnd,
  clipSourceOut,
  clipsOnTrack,
  clipsOverlap,
  createTimeline,
  findOverlapping,
  getClip,
  getTrack,
  linkGroup,
  mintId,
  patchClips,
  rangesOverlap,
  removeClips,
  slipRange,
  timelineDuration,
  trackIndex,
  withMarkers,
  withPlayhead,
  type Clip,
} from './timelineModel';

const TRACKS = [
  { id: 'v1', kind: 'video' as const, name: 'V1', role: '主画面' },
  { id: 'a1', kind: 'audio' as const, name: 'A1', role: '原声' },
];

function clip(overrides: Partial<Clip> & Pick<Clip, 'id'>): Clip {
  return {
    trackId: 'v1',
    start: 0,
    duration: 4,
    sourceIn: 0,
    sourceDuration: 10,
    speed: 1,
    label: overrides.id,
    ...overrides,
  };
}

describe('createTimeline', () => {
  it('sorts clips by track order, then start, then id', () => {
    const timeline = createTimeline({
      tracks: TRACKS,
      clips: [
        clip({ id: 'late', start: 8 }),
        clip({ id: 'audio', trackId: 'a1', start: 0 }),
        clip({ id: 'early', start: 0 }),
      ],
    });
    expect(timeline.clips.map((entry) => entry.id)).toEqual(['early', 'late', 'audio']);
  });

  it('sorts markers by time and defaults the playhead to zero', () => {
    const timeline = createTimeline({
      tracks: TRACKS,
      clips: [],
      markers: [
        { id: 'b', time: 55, label: 'b' },
        { id: 'a', time: 20, label: 'a' },
      ],
    });
    expect(timeline.markers.map((marker) => marker.id)).toEqual(['a', 'b']);
    expect(timeline.playhead).toBe(0);
  });

  it('never returns a negative playhead', () => {
    expect(createTimeline({ tracks: TRACKS, clips: [], playhead: -12 }).playhead).toBe(0);
  });

  it.each([
    ['duplicate clip id', [clip({ id: 'x' }), clip({ id: 'x', start: 8 })], /duplicate clip id/u],
    ['unknown track', [clip({ id: 'x', trackId: 'nope' })], /unknown track/u],
    ['zero duration', [clip({ id: 'x', duration: 0 })], /non-positive duration/u],
    ['negative start', [clip({ id: 'x', start: -1 })], /before zero/u],
    ['negative source in', [clip({ id: 'x', sourceIn: -1 })], /negative source in point/u],
    ['source overrun', [clip({ id: 'x', duration: 4, sourceIn: 8, sourceDuration: 10 })], /past the end/u],
  ])('rejects %s', (_name, clips, message) => {
    expect(() => createTimeline({ tracks: TRACKS, clips })).toThrow(message);
  });

  it('rejects duplicate track and marker ids', () => {
    expect(() => createTimeline({ tracks: [...TRACKS, TRACKS[0]!], clips: [] })).toThrow(/duplicate track id/u);
    expect(() =>
      createTimeline({
        tracks: TRACKS,
        clips: [],
        markers: [
          { id: 'm', time: 1, label: 'a' },
          { id: 'm', time: 2, label: 'b' },
        ],
      }),
    ).toThrow(/duplicate marker id/u);
  });

  it('accepts the artboard fixture unchanged', () => {
    const timeline = createSampleTimeline();
    expect(timeline.tracks.map((track) => track.name)).toEqual(['V2', 'V1', 'A1', 'A2', 'T1']);
    expect(timeline.clips).toHaveLength(10);
    expect(timelineDuration(timeline)).toBeCloseTo(86.667, 3);
  });
});

describe('clip geometry', () => {
  it('derives the timeline and source out points', () => {
    const aurora = getClip(createSampleTimeline(), 'v1-aurora');
    expect(clipEnd(aurora!)).toBeCloseTo(70.167, 3);
    expect(clipSourceOut(aurora!)).toBeCloseTo(32.133, 3);
  });

  it('reports how far the source window may still travel', () => {
    // 4.133s of head, 36 − 32.133 = 3.867s of tail.
    const range = slipRange(getClip(createSampleTimeline(), 'v1-aurora')!);
    expect(range.min).toBeCloseTo(-4.133, 3);
    expect(range.max).toBeCloseTo(3.867, 3);
  });

  it('treats touching edges as neighbours, not as an overlap', () => {
    expect(rangesOverlap(0, 4, 4, 8)).toBe(false);
    expect(rangesOverlap(0, 4, 3.999, 8)).toBe(true);
    expect(rangesOverlap(0, 4, 4 - 1e-9, 8)).toBe(false); // inside the epsilon
  });

  it('only counts an overlap within one track', () => {
    const a = clip({ id: 'a', trackId: 'v1', start: 0, duration: 4 });
    const b = clip({ id: 'b', trackId: 'a1', start: 2, duration: 4 });
    expect(clipsOverlap(a, b)).toBe(false);
    expect(clipsOverlap(a, { ...b, trackId: 'v1' })).toBe(true);
  });

  it('excludes both edges from containment, so a razor at a seam is not a cut', () => {
    const only = clip({ id: 'a', start: 4, duration: 4 });
    expect(clipContains(only, 4)).toBe(false);
    expect(clipContains(only, 8)).toBe(false);
    expect(clipContains(only, 4.001)).toBe(true);
  });
});

describe('queries', () => {
  const timeline = createSampleTimeline();

  it('finds tracks and their order', () => {
    expect(getTrack(timeline, 'v1')?.role).toBe('主画面');
    expect(trackIndex(timeline, 'v1')).toBe(1);
    expect(trackIndex(timeline, 'nope')).toBe(-1);
  });

  it('returns one lane in start order', () => {
    expect(clipsOnTrack(timeline, 'v1').map((entry) => entry.id)).toEqual(['v1-kael', 'v1-aurora', 'v1-rhea']);
  });

  it('finds the clip under a time and nothing in a gap', () => {
    expect(clipAt(timeline, 'v1', 20)?.id).toBe('v1-kael');
    expect(clipAt(timeline, 'v1', 42.1)).toBeUndefined(); // the 2-frame gap at 42.0–42.167
    expect(clipAt(timeline, 'v1', 200)).toBeUndefined();
  });

  it('returns the A/V pair with the addressed clip first', () => {
    expect(linkGroup(timeline, 'v1-aurora').map((entry) => entry.id)).toEqual(['v1-aurora', 'a1-aurora']);
    expect(linkGroup(timeline, 'a1-aurora').map((entry) => entry.id)).toEqual(['a1-aurora', 'v1-aurora']);
  });

  it('treats an unlinked clip as a group of one, and an unknown id as none', () => {
    expect(linkGroup(timeline, 'a2-music').map((entry) => entry.id)).toEqual(['a2-music']);
    expect(linkGroup(timeline, 'nope')).toEqual([]);
  });

  it('lists what a range would collide with, honouring the exclusion set', () => {
    expect(findOverlapping(timeline, 'v1', 30, 50).map((entry) => entry.id)).toEqual(['v1-kael', 'v1-aurora']);
    expect(findOverlapping(timeline, 'v1', 30, 50, new Set(['v1-kael'])).map((entry) => entry.id)).toEqual([
      'v1-aurora',
    ]);
    expect(findOverlapping(timeline, 'v1', 42, 42.167)).toEqual([]);
  });
});

describe('immutable updates', () => {
  it('never mutates its input', () => {
    const timeline = createLinearTimeline();
    const before = JSON.stringify(timeline);
    removeClips(timeline, new Set(['b']));
    patchClips(timeline, new Map([['a', { start: 99 }]]));
    withPlayhead(timeline, 12);
    withMarkers(timeline, [{ id: 'm', time: 1, label: 'm' }]);
    expect(JSON.stringify(timeline)).toBe(before);
  });

  it('re-sorts after a patch that reorders the lane', () => {
    const next = patchClips(createLinearTimeline(), new Map([['a', { start: 99 }]]));
    expect(next.clips.map((entry) => entry.id)).toEqual(['b', 'c', 'a']);
  });

  it('clamps the playhead at zero', () => {
    expect(withPlayhead(createLinearTimeline(), -5).playhead).toBe(0);
  });
});

describe('mintId', () => {
  it('derives a stable id and steps past collisions', () => {
    expect(mintId(new Set(['c1']), 'c1')).toBe('c1~2');
    expect(mintId(new Set(['c1', 'c1~2']), 'c1')).toBe('c1~3');
  });

  it('does not stack suffixes when splitting a split', () => {
    expect(mintId(new Set(['c1', 'c1~2']), 'c1~2')).toBe('c1~3');
  });
});
