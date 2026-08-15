import { describe, expect, it } from 'vitest';

import { createLinearTimeline, createSampleTimeline } from './sampleTimeline';
import {
  collectSnapTargets,
  DEFAULT_SNAP_THRESHOLD_PX,
  snapClipStart,
  snapRadiusSeconds,
  snapTime,
  type SnapTarget,
} from './snapping';
import { createTimeline, getClip } from './timelineModel';
import { createTimeScale } from './timeScale';

const AT_100 = { scale: createTimeScale(1) };

describe('snap targets', () => {
  it('collects clip edges, the playhead, the markers and the origin', () => {
    const targets = collectSnapTargets(createSampleTimeline(), { trackIds: new Set(['t1']) });
    expect(targets).toEqual([
      { time: 0, kind: 'origin' },
      { time: 8, kind: 'clip-start', id: 't1-clutch' },
      { time: 18, kind: 'clip-end', id: 't1-clutch' },
      { time: 20, kind: 'marker', id: 'm-entry' },
      { time: 31.167, kind: 'playhead' },
      { time: 55, kind: 'marker', id: 'm-clutch' },
    ]);
  });

  it('never offers the dragged clip its own edges', () => {
    const targets = collectSnapTargets(createLinearTimeline(), { excludeClipIds: new Set(['b']) });
    expect(targets.filter((target) => target.id === 'b')).toEqual([]);
    // …but its neighbours' edges are still there, including the seam it sat on.
    expect(targets.some((target) => target.kind === 'clip-end' && target.time === 4)).toBe(true);
  });

  it('crosses tracks: a video clip can snap to the audio it belongs with', () => {
    const targets = collectSnapTargets(createSampleTimeline(), {
      excludeClipIds: new Set(['v1-aurora', 'a1-aurora']),
    });
    expect(targets.some((target) => target.id === 'a1-kael')).toBe(true);
  });

  it('drops each source when asked', () => {
    const bare = collectSnapTargets(createSampleTimeline(), {
      includeMarkers: false,
      includePlayhead: false,
      includeOrigin: false,
      trackIds: new Set<string>(),
    });
    expect(bare).toEqual([]);
  });
});

describe('snap radius', () => {
  it('is a pixel distance converted at the current zoom', () => {
    expect(snapRadiusSeconds({ scale: createTimeScale(1) })).toBeCloseTo(DEFAULT_SNAP_THRESHOLD_PX / 12, 9);
    // Zooming in halves the seconds the same 8px covers — the point of §0.5's
    // 「阈值以像素计并随缩放换算」.
    expect(snapRadiusSeconds({ scale: createTimeScale(2) })).toBeCloseTo(DEFAULT_SNAP_THRESHOLD_PX / 24, 9);
    expect(snapRadiusSeconds({ scale: createTimeScale(0.5) })).toBeCloseTo(DEFAULT_SNAP_THRESHOLD_PX / 6, 9);
  });

  it('is zero for a zero threshold, which disables snapping', () => {
    expect(snapRadiusSeconds({ ...AT_100, thresholdPx: 0 })).toBe(0);
    const targets: SnapTarget[] = [{ time: 4, kind: 'playhead' }];
    expect(snapTime(4.0001, targets, { ...AT_100, thresholdPx: 0 }).snapped).toBe(false);
  });
});

describe('snapTime', () => {
  const targets: SnapTarget[] = [
    { time: 0, kind: 'origin' },
    { time: 4, kind: 'clip-end', id: 'a' },
    { time: 4, kind: 'clip-start', id: 'b' },
    { time: 20, kind: 'marker', id: 'm' },
  ];

  it('sticks inside the radius and lets go outside it', () => {
    // 8px at 12 px/s is 0.667s.
    expect(snapTime(4.5, targets, AT_100)).toMatchObject({ time: 4, snapped: true });
    expect(snapTime(4.7, targets, AT_100).snapped).toBe(false);
  });

  it('reports the correction it applied', () => {
    expect(snapTime(4.5, targets, AT_100).deltaSeconds).toBeCloseTo(-0.5, 9);
    expect(snapTime(19.6, targets, AT_100).deltaSeconds).toBeCloseTo(0.4, 9);
  });

  it('lets go of the same distance once the view zooms in', () => {
    expect(snapTime(4.5, targets, AT_100).snapped).toBe(true);
    expect(snapTime(4.5, targets, { scale: createTimeScale(4) }).snapped).toBe(false);
  });

  it('picks the nearer of two targets', () => {
    expect(snapTime(4.4, [...targets, { time: 4.5, kind: 'marker', id: 'n' }], AT_100).target).toMatchObject({
      time: 4.5,
    });
  });

  it('breaks an exact tie by kind, deliberately: the playhead first', () => {
    const tied: SnapTarget[] = [
      { time: 4, kind: 'clip-start', id: 'b' },
      { time: 4, kind: 'playhead' },
      { time: 4, kind: 'marker', id: 'm' },
    ];
    expect(snapTime(4.2, tied, AT_100).target?.kind).toBe('playhead');
    expect(snapTime(4.2, [tied[0]!, tied[2]!], AT_100).target?.kind).toBe('marker');
  });

  it('is order independent', () => {
    const forward = snapTime(4.3, targets, AT_100);
    const backward = snapTime(4.3, [...targets].reverse(), AT_100);
    expect(backward).toEqual(forward);
  });

  it('returns the input untouched when nothing is near', () => {
    expect(snapTime(100, targets, AT_100)).toEqual({ time: 100, snapped: false, deltaSeconds: 0 });
    expect(snapTime(4.5, [], AT_100).snapped).toBe(false);
  });
});

describe('snapClipStart', () => {
  const targets: SnapTarget[] = [
    { time: 0, kind: 'origin' },
    { time: 10, kind: 'clip-start', id: 'x' },
    { time: 30, kind: 'clip-start', id: 'y' },
  ];

  it('snaps the left edge to a target ahead of it', () => {
    const result = snapClipStart(9.6, 4, targets, AT_100);
    expect(result).toMatchObject({ time: 10, edge: 'start', snapped: true });
  });

  it('snaps the right edge, and answers in terms of the left one', () => {
    // A 4s clip at 26.5 ends at 30.5, half a second past the target.
    const result = snapClipStart(26.5, 4, targets, AT_100);
    expect(result.edge).toBe('end');
    expect(result.time).toBeCloseTo(26, 9);
    expect(result.deltaSeconds).toBeCloseTo(-0.5, 9);
  });

  it('gives the nearer edge the magnet when both are in range', () => {
    // A 20s clip from 9.7 (left edge 0.3 out) to 29.7 (right edge 0.3 out):
    // an exact tie, and the left edge is the one the pointer is holding.
    expect(snapClipStart(9.7, 20, targets, AT_100).edge).toBe('start');
    // Nudge the right edge closer and it takes over.
    expect(snapClipStart(9.6, 20.5, targets, AT_100).edge).toBe('end');
  });

  it('leaves a clip alone in open water', () => {
    expect(snapClipStart(50, 4, targets, AT_100)).toEqual({ time: 50, snapped: false, deltaSeconds: 0 });
  });

  it('never corrects by more than the radius — snapping moves a clip, it never trims one', () => {
    for (const start of [0.4, 9.8, 26.4, 29.9, 50]) {
      const result = snapClipStart(start, 4, targets, AT_100);
      expect(Math.abs(result.deltaSeconds)).toBeLessThanOrEqual(snapRadiusSeconds(AT_100) + 1e-9);
      expect(result.time).toBeCloseTo(start + result.deltaSeconds, 9);
    }
  });

  it('works against a real sequence: an A/V pair dropped next to its neighbour', () => {
    const timeline = createSampleTimeline();
    const aurora = getClip(timeline, 'v1-aurora')!;
    const targets = collectSnapTargets(timeline, { excludeClipIds: new Set(['v1-aurora', 'a1-aurora']) });
    // Dragged to 41.9 — 0.1s shy of the end of Kael on V1 (42.0).
    const result = snapClipStart(41.9, aurora.duration, targets, AT_100);
    expect(result.time).toBeCloseTo(42, 9);
    expect(result.target).toMatchObject({ kind: 'clip-end' });
  });

  it('never invents a negative start when snapping to the origin', () => {
    const result = snapClipStart(0.3, 4, [{ time: 0, kind: 'origin' }], AT_100);
    expect(result.time).toBe(0);
  });
});

describe('snapping against an empty document', () => {
  it('offers only the origin and the playhead', () => {
    const empty = createTimeline({
      tracks: [{ id: 'v1', kind: 'video', name: 'V1', role: '主画面' }],
      clips: [],
      playhead: 12,
    });
    expect(collectSnapTargets(empty)).toEqual([
      { time: 0, kind: 'origin' },
      { time: 12, kind: 'playhead' },
    ]);
  });

  it('puts the playhead before the origin when they coincide, per the tie order', () => {
    const empty = createTimeline({ tracks: [{ id: 'v1', kind: 'video', name: 'V1', role: '主画面' }], clips: [] });
    expect(collectSnapTargets(empty).map((target) => target.kind)).toEqual(['playhead', 'origin']);
  });
});
