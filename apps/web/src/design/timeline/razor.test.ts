import { describe, expect, it } from 'vitest';

import { canRazorAt, razorAt, seamsOnTrack, splitClipAt } from './razor';
import { createLinearTimeline, createSampleTimeline } from './sampleTimeline';
import { clipEnd, clipSourceOut, createTimeline, getClip, type Timeline } from './timelineModel';

function ids(timeline: Timeline, trackId: string): string[] {
  return timeline.clips.filter((clip) => clip.trackId === trackId).map((clip) => clip.id);
}

describe('splitClipAt', () => {
  it('cuts one clip into two that meet exactly where the blade fell', () => {
    const { timeline, applied, leftIds, rightIds } = splitClipAt(createLinearTimeline(), 'b', 6);
    expect(applied).toBe(true);
    expect(leftIds).toEqual(['b']);
    expect(rightIds).toEqual(['b~2']);

    const left = getClip(timeline, 'b')!;
    const right = getClip(timeline, 'b~2')!;
    expect(left.start).toBe(4);
    expect(left.duration).toBe(2);
    expect(clipEnd(left)).toBe(right.start);
    expect(right.duration).toBe(2);
    expect(clipEnd(right)).toBe(8);
  });

  it('carries the source window across the cut — the half that could go wrong', () => {
    // `b` shows source 2.0–6.0 over timeline 4.0–8.0. Cutting at 6.0 (2s in)
    // must leave the right half showing 4.0–6.0, not 2.0–4.0.
    const { timeline } = splitClipAt(createLinearTimeline(), 'b', 6);
    const left = getClip(timeline, 'b')!;
    const right = getClip(timeline, 'b~2')!;

    expect(left.sourceIn).toBe(2);
    expect(clipSourceOut(left)).toBe(4);
    expect(right.sourceIn).toBe(4);
    expect(clipSourceOut(right)).toBe(6);
    // Nothing is lost and nothing is repeated.
    expect(clipSourceOut(left)).toBe(right.sourceIn);
    expect(left.duration + right.duration).toBe(4);
    expect(left.sourceDuration).toBe(right.sourceDuration);
  });

  it('holds the invariants at every interior instant of a clip', () => {
    const base = createLinearTimeline();
    // `b` runs 4–8; step through its interior without ever reaching an edge.
    for (let step = 1; step < 80; step += 1) {
      const time = 4 + step * 0.05;
      const { timeline, applied } = splitClipAt(base, 'b', time);
      expect(applied).toBe(true);
      const left = getClip(timeline, 'b')!;
      const right = getClip(timeline, 'b~2')!;
      expect(clipEnd(left)).toBeCloseTo(right.start, 9);
      expect(clipSourceOut(left)).toBeCloseTo(right.sourceIn, 9);
      expect(left.duration + right.duration).toBeCloseTo(4, 9);
      expect(left.duration).toBeGreaterThan(0);
      expect(right.duration).toBeGreaterThan(0);
      expect(right.sourceIn + right.duration).toBeLessThanOrEqual(right.sourceDuration + 1e-9);
    }
  });

  it('refuses a cut on either edge rather than making a zero-length clip', () => {
    const base = createLinearTimeline();
    for (const time of [4, 8, 0, 12, -1, 100]) {
      const result = splitClipAt(base, 'b', time);
      expect(result.applied).toBe(false);
      expect(result.reason).toBe('out-of-bounds');
      expect(result.timeline).toBe(base);
    }
  });

  it('refuses an unknown clip and a locked track', () => {
    expect(splitClipAt(createLinearTimeline(), 'nope', 6).reason).toBe('unknown-clip');

    const locked = createTimeline({
      tracks: [{ id: 'v1', kind: 'video', name: 'V1', role: '主画面', locked: true }],
      clips: [{ id: 'a', trackId: 'v1', start: 0, duration: 4, sourceIn: 0, sourceDuration: 10, label: 'A' }],
    });
    expect(splitClipAt(locked, 'a', 2).reason).toBe('track-locked');
  });

  it('does not mutate the timeline it was handed', () => {
    const base = createLinearTimeline();
    const before = JSON.stringify(base);
    splitClipAt(base, 'b', 6);
    expect(JSON.stringify(base)).toBe(before);
  });
});

describe('splitClipAt with a link group', () => {
  it('cuts the A/V pair at the same instant', () => {
    const { timeline, leftIds, rightIds } = splitClipAt(createSampleTimeline(), 'v1-aurora', 50);
    expect(leftIds).toEqual(['v1-aurora', 'a1-aurora']);
    expect(rightIds).toEqual(['v1-aurora~2', 'a1-aurora~2']);

    for (const id of ['v1-aurora', 'a1-aurora']) {
      expect(clipEnd(getClip(timeline, id)!)).toBeCloseTo(50, 9);
    }
    for (const id of ['v1-aurora~2', 'a1-aurora~2']) {
      expect(getClip(timeline, id)!.start).toBe(50);
    }
  });

  it('re-links the halves so the left video no longer drags the right audio', () => {
    const { timeline } = splitClipAt(createSampleTimeline(), 'v1-aurora', 50);
    const leftVideo = getClip(timeline, 'v1-aurora')!;
    const leftAudio = getClip(timeline, 'a1-aurora')!;
    const rightVideo = getClip(timeline, 'v1-aurora~2')!;
    const rightAudio = getClip(timeline, 'a1-aurora~2')!;

    expect(leftVideo.linkId).toBe('av-aurora');
    expect(leftAudio.linkId).toBe('av-aurora');
    expect(rightVideo.linkId).toBe(rightAudio.linkId);
    expect(rightVideo.linkId).not.toBe('av-aurora');
  });

  it('cuts only the clip asked for when the link is ignored', () => {
    const { timeline, leftIds } = splitClipAt(createSampleTimeline(), 'v1-aurora', 50, { linked: false });
    expect(leftIds).toEqual(['v1-aurora']);
    expect(getClip(timeline, 'a1-aurora')!.duration).toBe(28);
  });

  it('cuts the partners that cross the blade and leaves the ones that do not', () => {
    // A pair whose audio is shorter than its video: cutting past the audio's
    // end must still cut the video.
    const timeline = createTimeline({
      tracks: [
        { id: 'v1', kind: 'video', name: 'V1', role: '主画面' },
        { id: 'a1', kind: 'audio', name: 'A1', role: '原声' },
      ],
      clips: [
        { id: 'v', trackId: 'v1', start: 0, duration: 10, sourceIn: 0, sourceDuration: 10, label: 'v', linkId: 'g' },
        { id: 'a', trackId: 'a1', start: 0, duration: 4, sourceIn: 0, sourceDuration: 4, label: 'a', linkId: 'g' },
      ],
    });
    const result = splitClipAt(timeline, 'v', 6);
    expect(result.leftIds).toEqual(['v']);
    expect(result.rightIds).toEqual(['v~2']);
    expect(getClip(result.timeline, 'a')!.duration).toBe(4);
  });
});

describe('razorAt', () => {
  it('cuts every clip the playhead crosses', () => {
    const { timeline, applied, leftIds } = razorAt(createSampleTimeline(), 31.167);
    expect(applied).toBe(true);
    // At 31.167 the blade crosses V1 Kael, A1 Kael and A2 music. V2 Kael ends
    // at 23 and T1 at 18, so neither is cut.
    expect(leftIds.sort()).toEqual(['a1-kael', 'a2-music', 'v1-kael']);
    expect(ids(timeline, 'v2')).toEqual(['v2-kael', 'v2-rhea']);
  });

  it('keeps the pieces of one link group together across a multi-clip cut', () => {
    const { timeline } = razorAt(createSampleTimeline(), 31.167);
    const rightVideo = getClip(timeline, 'v1-kael~2')!;
    const rightAudio = getClip(timeline, 'a1-kael~2')!;
    expect(rightVideo.linkId).toBe(rightAudio.linkId);
    expect(rightVideo.linkId).not.toBe('av-kael');
    expect(getClip(timeline, 'v1-kael')!.linkId).toBe('av-kael');
  });

  it('can be restricted to a set of tracks', () => {
    const { timeline, leftIds } = razorAt(createSampleTimeline(), 31.167, { trackIds: new Set(['v1']) });
    expect(leftIds).toEqual(['v1-kael']);
    expect(getClip(timeline, 'a1-kael')!.duration).toBe(42);
  });

  it('refuses when the blade falls in empty space on every track', () => {
    const result = razorAt(createSampleTimeline(), 200);
    expect(result.applied).toBe(false);
    expect(result.reason).toBe('out-of-bounds');
  });

  it('mints unique ids for every piece', () => {
    const { timeline } = razorAt(createSampleTimeline(), 31.167);
    expect(new Set(timeline.clips.map((clip) => clip.id)).size).toBe(timeline.clips.length);
  });

  it('survives being run twice on the same instant', () => {
    const once = razorAt(createSampleTimeline(), 31.167).timeline;
    const twice = razorAt(once, 31.167);
    // The seam is now a boundary, so there is nothing left to cut there.
    expect(twice.applied).toBe(false);
    expect(twice.reason).toBe('out-of-bounds');
  });

  it('can be run at two instants in a row', () => {
    const once = razorAt(createSampleTimeline(), 20).timeline;
    const twice = razorAt(once, 31.167);
    expect(twice.applied).toBe(true);
    expect(new Set(twice.timeline.clips.map((clip) => clip.id)).size).toBe(twice.timeline.clips.length);
    expect(ids(twice.timeline, 'v1')).toEqual(['v1-kael', 'v1-kael~2', 'v1-kael~3', 'v1-aurora', 'v1-rhea']);
  });
});

describe('razor affordances', () => {
  it('reports whether the blade would bite', () => {
    const timeline = createSampleTimeline();
    expect(canRazorAt(timeline, 31.167)).toBe(true);
    expect(canRazorAt(timeline, 31.167, new Set(['t1']))).toBe(false);
    expect(canRazorAt(timeline, 42.1)).toBe(true); // A2 runs under the V1 gap
    expect(canRazorAt(timeline, 200)).toBe(false);
  });

  it('lists the seams of a lane once each', () => {
    expect(seamsOnTrack(createLinearTimeline(), 'v1')).toEqual([0, 4, 8, 12]);
  });
});
