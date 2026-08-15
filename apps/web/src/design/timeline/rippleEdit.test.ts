import { describe, expect, it } from 'vitest';

import { liftDelete, rippleDelete, rippleImpact, trackDuration } from './rippleEdit';
import { createLinearTimeline, createSampleTimeline } from './sampleTimeline';
import { createTimeline, getClip, timelineDuration, type Timeline } from './timelineModel';

function starts(timeline: Timeline, trackId: string): Array<[string, number]> {
  return timeline.clips.filter((clip) => clip.trackId === trackId).map((clip) => [clip.id, clip.start]);
}

describe('rippleDelete on one lane', () => {
  it('removes the clip and pulls everything after it left by its length', () => {
    const { timeline, applied, removedIds, shiftedIds } = rippleDelete(createLinearTimeline(), 'b');
    expect(applied).toBe(true);
    expect(removedIds).toEqual(['b']);
    expect(shiftedIds).toEqual(['c']);
    expect(starts(timeline, 'v1')).toEqual([
      ['a', 0],
      ['c', 4],
    ]);
    expect(timelineDuration(timeline)).toBe(8);
  });

  it('leaves the clips before the cut alone', () => {
    const { timeline } = rippleDelete(createLinearTimeline(), 'c');
    expect(starts(timeline, 'v1')).toEqual([
      ['a', 0],
      ['b', 4],
    ]);
  });

  it('shifts a clip that starts exactly where the removed one did', () => {
    // Two clips stacked on separate lanes at the same instant: the one on the
    // removed clip's own lane must move, and `>= start` is what makes it.
    const timeline = createTimeline({
      tracks: [{ id: 'v1', kind: 'video', name: 'V1', role: '主画面' }],
      clips: [
        { id: 'a', trackId: 'v1', start: 0, duration: 4, sourceIn: 0, sourceDuration: 10, label: 'a' },
        { id: 'b', trackId: 'v1', start: 4, duration: 4, sourceIn: 0, sourceDuration: 10, label: 'b' },
      ],
    });
    expect(starts(rippleDelete(timeline, 'a').timeline, 'v1')).toEqual([['b', 0]]);
  });

  it('shifts by the clip’s length, not to where the clip was', () => {
    // A lane with a hole in it: the follower keeps the 2s gap it had.
    const timeline = createTimeline({
      tracks: [{ id: 'v1', kind: 'video', name: 'V1', role: '主画面' }],
      clips: [
        { id: 'a', trackId: 'v1', start: 20, duration: 10, sourceIn: 0, sourceDuration: 10, label: 'a' },
        { id: 'b', trackId: 'v1', start: 32, duration: 4, sourceIn: 0, sourceDuration: 10, label: 'b' },
      ],
    });
    expect(starts(rippleDelete(timeline, 'a').timeline, 'v1')).toEqual([['b', 22]]);
  });

  it('does not touch the source window of what it shifts', () => {
    const before = getClip(createLinearTimeline(), 'c')!;
    const after = getClip(rippleDelete(createLinearTimeline(), 'b').timeline, 'c')!;
    expect(after).toEqual({ ...before, start: 4 });
  });

  it('refuses an unknown clip and a locked lane', () => {
    const base = createLinearTimeline();
    expect(rippleDelete(base, 'nope')).toMatchObject({ applied: false, reason: 'unknown-clip', timeline: base });

    const locked = createTimeline({
      tracks: [{ id: 'v1', kind: 'video', name: 'V1', role: '主画面', locked: true }],
      clips: [{ id: 'a', trackId: 'v1', start: 0, duration: 4, sourceIn: 0, sourceDuration: 10, label: 'a' }],
    });
    expect(rippleDelete(locked, 'a').reason).toBe('track-locked');
  });

  it('does not mutate its input', () => {
    const base = createLinearTimeline();
    const before = JSON.stringify(base);
    rippleDelete(base, 'b');
    expect(JSON.stringify(base)).toBe(before);
  });
});

describe('rippleDelete scopes', () => {
  it('linked (the default): the A/V pair goes and both lanes close up', () => {
    const { timeline, removedIds, shiftedIds, gapByTrack } = rippleDelete(createSampleTimeline(), 'v1-kael');
    expect(removedIds.sort()).toEqual(['a1-kael', 'v1-kael']);
    expect(gapByTrack).toEqual({ v1: 42, a1: 42 });

    // Everything after 0 on V1 and A1 moves; the music on A2 does not.
    expect(shiftedIds.sort()).toEqual(['a1-aurora', 'a1-rhea', 'v1-aurora', 'v1-rhea']);
    expect(getClip(timeline, 'v1-aurora')!.start).toBeCloseTo(0.167, 6);
    expect(getClip(timeline, 'a1-aurora')!.start).toBeCloseTo(0.167, 6);
    expect(getClip(timeline, 'a2-music')!.start).toBe(0);
    expect(getClip(timeline, 'a2-music')!.duration).toBeCloseTo(86.667, 3);
  });

  it('keeps the A/V pairs in sync — the property that makes 链接 worth having', () => {
    const { timeline } = rippleDelete(createSampleTimeline(), 'v1-kael');
    const pairs: Array<[string, string]> = [
      ['v1-aurora', 'a1-aurora'],
      ['v1-rhea', 'a1-rhea'],
    ];
    for (const [video, audio] of pairs) {
      expect(getClip(timeline, video)!.start).toBe(getClip(timeline, audio)!.start);
    }
  });

  it('track: only the clip’s own lane closes, the partner is deleted where it stands', () => {
    const { timeline, gapByTrack } = rippleDelete(createSampleTimeline(), 'v1-kael', { scope: 'track' });
    expect(gapByTrack).toEqual({ v1: 42 });
    expect(getClip(timeline, 'v1-aurora')!.start).toBeCloseTo(0.167, 6);
    expect(getClip(timeline, 'a1-aurora')!.start).toBeCloseTo(42.167, 6);
  });

  it('all: every lane shifts by the same gap, including ones that lost nothing', () => {
    const { timeline, gapByTrack } = rippleDelete(createSampleTimeline(), 'v1-kael', { scope: 'all' });
    expect(gapByTrack).toEqual({ v2: 42, v1: 42, a1: 42, a2: 42, t1: 42 });
    // V2 名牌 · Rhea starts at 70 and moves to 28; 名牌 · Kael starts at 8, which
    // is after the cut at 0, so it moves too — and is clamped at zero.
    expect(starts(timeline, 'v2')).toEqual([
      ['v2-kael', 0],
      ['v2-rhea', 28],
    ]);
    expect(getClip(timeline, 'a2-music')!.start).toBe(0);
  });

  it('deletes only the addressed clip when the link is ignored', () => {
    const { timeline, removedIds } = rippleDelete(createSampleTimeline(), 'v1-kael', { linked: false });
    expect(removedIds).toEqual(['v1-kael']);
    expect(getClip(timeline, 'a1-kael')).toBeDefined();
    expect(getClip(timeline, 'a1-kael')!.start).toBe(0);
  });

  it('never moves a clip on a locked lane, whatever the scope', () => {
    const timeline = createTimeline({
      tracks: [
        { id: 'v1', kind: 'video', name: 'V1', role: '主画面' },
        { id: 'v2', kind: 'video', name: 'V2', role: '叠加', locked: true },
      ],
      clips: [
        { id: 'a', trackId: 'v1', start: 0, duration: 4, sourceIn: 0, sourceDuration: 10, label: 'a' },
        { id: 'b', trackId: 'v1', start: 4, duration: 4, sourceIn: 0, sourceDuration: 10, label: 'b' },
        { id: 'locked', trackId: 'v2', start: 4, duration: 4, sourceIn: 0, sourceDuration: 10, label: 'locked' },
      ],
    });
    const { timeline: next } = rippleDelete(timeline, 'a', { scope: 'all' });
    expect(getClip(next, 'b')!.start).toBe(0);
    expect(getClip(next, 'locked')!.start).toBe(4);
  });
});

describe('markers and the playhead', () => {
  it('leaves markers alone by default — a marker names a moment in the match', () => {
    const { timeline } = rippleDelete(createSampleTimeline(), 'v1-kael');
    expect(timeline.markers.map((marker) => marker.time)).toEqual([20, 55]);
  });

  it('moves the ones after the cut when asked', () => {
    const { timeline } = rippleDelete(createSampleTimeline(), 'v1-aurora', { rippleMarkers: true });
    // The cut is at 42.167: the 20s marker stays, the 55s one closes by 28.
    expect(timeline.markers.map((marker) => marker.time)).toEqual([20, 27]);
  });

  it('never moves the playhead', () => {
    const before = createSampleTimeline();
    expect(rippleDelete(before, 'v1-kael').timeline.playhead).toBe(before.playhead);
  });
});

describe('liftDelete', () => {
  it('removes the clip and leaves the hole', () => {
    const { timeline, shiftedIds } = liftDelete(createLinearTimeline(), 'b');
    expect(shiftedIds).toEqual([]);
    expect(starts(timeline, 'v1')).toEqual([
      ['a', 0],
      ['c', 8],
    ]);
    expect(timelineDuration(timeline)).toBe(12);
  });

  it('still takes the A/V pair', () => {
    const { removedIds } = liftDelete(createSampleTimeline(), 'v1-kael');
    expect(removedIds.sort()).toEqual(['a1-kael', 'v1-kael']);
  });
});

describe('reporting', () => {
  it('describes the impact before it happens', () => {
    expect(rippleImpact(createSampleTimeline(), 'v1-kael')).toEqual({ removed: 2, shifted: 4, gapSeconds: 42 });
  });

  it('measures one lane', () => {
    const timeline = createSampleTimeline();
    expect(trackDuration(timeline, 'v1')).toBeCloseTo(86.666, 3);
    expect(trackDuration(rippleDelete(timeline, 'v1-kael').timeline, 'v1')).toBeCloseTo(44.666, 3);
    expect(trackDuration(timeline, 'nope')).toBe(0);
  });
});
