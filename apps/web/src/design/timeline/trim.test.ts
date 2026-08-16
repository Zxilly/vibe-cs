import { describe, expect, it } from 'vitest';

import { frameDuration } from './frameGrid';
import { createLinearTimeline, createSampleTimeline } from './sampleTimeline';
import {
  clipEnd,
  clipSourceOut,
  createTimeline,
  getClip,
  trimHeadroom,
  type Timeline,
} from './timelineModel';
import { TIME_EPSILON } from './timeScale';
import { groupTrimRange, trimClip, trimPreview, trimRange } from './trim';

const FRAME = frameDuration(60);

/** One clip alone on a lane, with room at both ends of its source. */
function solo(overrides: Partial<Parameters<typeof createTimeline>[0]['clips'][number]> = {}): Timeline {
  return createTimeline({
    tracks: [{ id: 'v1', kind: 'video', name: 'V1', role: '主画面' }],
    clips: [
      {
        id: 'a',
        trackId: 'v1',
        start: 10,
        duration: 4,
        sourceIn: 3,
        sourceDuration: 20,
        label: 'A',
        ...overrides,
      },
    ],
  });
}

/** A/V pair whose halves deliberately start a few frames apart — a J-cut. */
function jCut(): Timeline {
  return createTimeline({
    tracks: [
      { id: 'v1', kind: 'video', name: 'V1', role: '主画面' },
      { id: 'a1', kind: 'audio', name: 'A1', role: '原声' },
    ],
    clips: [
      { id: 'v', trackId: 'v1', start: 10, duration: 4, sourceIn: 3, sourceDuration: 20, label: 'V', linkId: 'p' },
      { id: 'a', trackId: 'a1', start: 9.5, duration: 4.5, sourceIn: 2.5, sourceDuration: 20, label: 'A', linkId: 'p' },
    ],
  });
}

describe('trimClip — the arithmetic', () => {
  it('moves start, duration and the in point together on the in edge', () => {
    const { timeline, applied, appliedDelta } = trimClip(solo(), 'a', 'in', 1);
    const trimmed = getClip(timeline, 'a')!;
    expect(applied).toBe(true);
    expect(appliedDelta).toBe(1);
    expect(trimmed.start).toBe(11);
    expect(trimmed.duration).toBe(3);
    // The frame under the cursor stays under the cursor: the source window's
    // near edge travels exactly as far as the timeline edge did.
    expect(trimmed.sourceIn).toBe(4);
    expect(clipSourceOut(trimmed)).toBe(clipSourceOut(getClip(solo(), 'a')!));
  });

  it('moves only duration on the out edge', () => {
    const trimmed = getClip(trimClip(solo(), 'a', 'out', 1).timeline, 'a')!;
    expect(trimmed.start).toBe(10);
    expect(trimmed.duration).toBe(5);
    expect(trimmed.sourceIn).toBe(3);
  });

  it('scales the source window by speed', () => {
    // At 200% a second of timeline eats two seconds of source, so trimming one
    // second off the head advances the in point by two.
    const trimmed = getClip(trimClip(solo({ speed: 2 }), 'a', 'in', 1).timeline, 'a')!;
    expect(trimmed.sourceIn).toBe(5);
    expect(trimmed.duration).toBe(3);
  });

  it('is its own inverse', () => {
    const once = trimClip(solo(), 'a', 'in', 1).timeline;
    const back = trimClip(once, 'a', 'in', -1).timeline;
    expect(getClip(back, 'a')).toEqual(getClip(solo(), 'a'));
  });
});

describe('trimClip — the four bounds', () => {
  it('clamps at the end of the source rather than refusing', () => {
    // 3s of head is all there is; dragging further is the normal gesture at
    // the end of a shot, and a refusal there would read as a bug (the same
    // call `slip.ts` makes).
    const { appliedDelta, applied } = trimClip(solo(), 'a', 'in', -100);
    expect(applied).toBe(true);
    expect(appliedDelta).toBe(-3);
    expect(trimHeadroom(getClip(trimClip(solo(), 'a', 'in', -100).timeline, 'a')!).in).toBe(0);
  });

  it('clamps at the neighbour on the same track', () => {
    // `createLinearTimeline` is A[0,4) B[4,8) C[8,12); B cannot grow left.
    const { appliedDelta } = trimClip(createLinearTimeline(), 'b', 'in', -10);
    expect(appliedDelta).toBe(0);
    expect(trimClip(createLinearTimeline(), 'b', 'in', -10).applied).toBe(false);
    // …but it can grow right into nothing, because A's end is exactly its start.
    expect(trimClip(createLinearTimeline(), 'b', 'in', 1).appliedDelta).toBe(1);
  });

  it('clamps at t = 0', () => {
    const atZero = solo({ start: 1, sourceIn: 10 });
    expect(trimClip(atZero, 'a', 'in', -100).appliedDelta).toBe(-1);
    expect(getClip(trimClip(atZero, 'a', 'in', -100).timeline, 'a')!.start).toBe(0);
  });

  it('refuses to leave less than a frame, and says which kind of refusal it is', () => {
    const shrunk = trimClip(solo(), 'a', 'in', 4);
    expect(shrunk.applied).toBe(true);
    expect(shrunk.appliedDelta).toBeCloseTo(4 - FRAME, 12);

    const again = trimClip(shrunk.timeline, 'a', 'in', 1);
    expect(again.applied).toBe(false);
    expect(again.reason).toBe('too-short');
  });

  it('says no-headroom when the source is what ran out', () => {
    const spent = trimClip(solo(), 'a', 'in', -3).timeline;
    const refused = trimClip(spent, 'a', 'in', -1);
    expect(refused.applied).toBe(false);
    expect(refused.reason).toBe('no-headroom');
  });

  it('honours a caller’s longer minimum', () => {
    const { appliedDelta } = trimClip(solo(), 'a', 'out', -100, { minFrames: 60 });
    expect(appliedDelta).toBeCloseTo(-3, 12);
  });
});

describe('trimClip — the link group', () => {
  it('trims both halves by the same delta, keeping a J-cut’s offset', () => {
    const { timeline } = trimClip(jCut(), 'v', 'in', 0.5);
    const video = getClip(timeline, 'v')!;
    const audio = getClip(timeline, 'a')!;
    expect(video.start).toBe(10.5);
    expect(audio.start).toBe(10);
    // Trimming them *to* a common edge would have destroyed the J-cut.
    expect(video.start - audio.start).toBe(0.5);
    expect(video.duration).toBe(3.5);
    expect(audio.duration).toBe(4);
  });

  it('takes the tightest of the members’ ranges', () => {
    // The audio has 2.5s of head, the video 3s, so the pair has 2.5s.
    expect(groupTrimRange(jCut(), [getClip(jCut(), 'v')!, getClip(jCut(), 'a')!], 'in').min).toBe(-2.5);
    expect(trimClip(jCut(), 'v', 'in', -100).appliedDelta).toBe(-2.5);
  });

  it('can be driven from either half', () => {
    const fromVideo = trimClip(jCut(), 'v', 'out', 1).timeline;
    const fromAudio = trimClip(jCut(), 'a', 'out', 1).timeline;
    expect(getClip(fromVideo, 'a')!.duration).toBe(getClip(fromAudio, 'a')!.duration);
    expect(getClip(fromVideo, 'v')!.duration).toBe(getClip(fromAudio, 'v')!.duration);
  });

  it('trims one alone when asked', () => {
    const { timeline } = trimClip(jCut(), 'v', 'in', 0.5, { linked: false });
    expect(getClip(timeline, 'v')!.start).toBe(10.5);
    expect(getClip(timeline, 'a')!.start).toBe(9.5);
  });

  it('ignores its own group when hunting for a neighbour', () => {
    // The pair overlaps in time on two lanes. Without the exclusion each half
    // would see the other as a neighbour it must not run into — and since
    // they are on different tracks, that would be nonsense.
    expect(trimClip(jCut(), 'v', 'out', 1).applied).toBe(true);
  });
});

describe('trimClip — refusals that are not clamps', () => {
  it('refuses an unknown clip', () => {
    expect(trimClip(solo(), 'nope', 'in', 1).reason).toBe('unknown-clip');
  });

  it('refuses a locked track', () => {
    const locked = createTimeline({
      tracks: [{ id: 'v1', kind: 'video', name: 'V1', role: '主画面', locked: true }],
      clips: [{ id: 'a', trackId: 'v1', start: 0, duration: 4, sourceIn: 0, sourceDuration: 10, label: 'A' }],
    });
    expect(trimClip(locked, 'a', 'in', 1).reason).toBe('track-locked');
  });

  it('reports no-change for a zero delta', () => {
    expect(trimClip(solo(), 'a', 'in', 0).reason).toBe('no-change');
  });
});

describe('trimRange', () => {
  it('uses one sign convention for both edges', () => {
    // Positive is later on the timeline either way, so a caller never flips a
    // delta based on which handle the pointer grabbed.
    const timeline = solo();
    const only = getClip(timeline, 'a')!;
    expect(trimRange(timeline, only, 'in').max).toBeCloseTo(4 - FRAME, 12);
    expect(trimRange(timeline, only, 'out').min).toBeCloseTo(-(4 - FRAME), 12);
  });

  it('is unbounded on the side with no neighbour and no source limit', () => {
    const timeline = solo({ sourceDuration: 1_000_000 });
    expect(trimRange(timeline, getClip(timeline, 'a')!, 'out').max).toBeGreaterThan(1000);
  });

  it('reports the room a clamped trim has left', () => {
    const { range } = trimClip(solo(), 'a', 'in', -1);
    expect(range.min).toBe(-2);
  });

  it('degrades to no room rather than an inverted range', () => {
    // A group with no common answer must not produce min > max, which would
    // drag the edge the wrong way.
    const impossible = groupTrimRange(createLinearTimeline(), [], 'in');
    expect(impossible).toEqual({ min: 0, max: 0 });
  });
});

describe('trimPreview', () => {
  it('is what the commit will do, without doing it', () => {
    const timeline = createSampleTimeline();
    const clip = getClip(timeline, 'v1-aurora')!;
    const preview = trimPreview(timeline, clip, 'in', 1);
    const committed = getClip(trimClip(timeline, 'v1-aurora', 'in', 1).timeline, 'v1-aurora')!;

    expect(preview.start).toBeCloseTo(committed.start, 12);
    expect(preview.duration).toBeCloseTo(committed.duration, 12);
    expect(preview.sourceIn).toBeCloseTo(committed.sourceIn, 12);
    expect(preview.sourceOut).toBeCloseTo(clipSourceOut(committed), 12);
    // …and the document is untouched.
    expect(getClip(timeline, 'v1-aurora')).toEqual(clip);
  });

  it('reports the clamp so the edge stops where the trim would stop', () => {
    const timeline = solo();
    const preview = trimPreview(timeline, getClip(timeline, 'a')!, 'in', -100);
    expect(preview.appliedDelta).toBe(-3);
    expect(preview.start).toBe(7);
  });
});

describe('what a trim leaves the document', () => {
  it('never produces a clip that overruns its source', () => {
    // Exhaustive over the whole legal range at frame resolution, both edges.
    const timeline = solo();
    for (const edge of ['in', 'out'] as const) {
      for (let frames = -400; frames <= 400; frames += 1) {
        const { timeline: next } = trimClip(timeline, 'a', edge, frames * FRAME);
        const trimmed = getClip(next, 'a')!;
        expect(trimmed.duration).toBeGreaterThan(0);
        expect(trimmed.sourceIn).toBeGreaterThanOrEqual(-TIME_EPSILON);
        expect(clipSourceOut(trimmed)).toBeLessThanOrEqual(trimmed.sourceDuration + TIME_EPSILON);
        expect(trimmed.start).toBeGreaterThanOrEqual(-TIME_EPSILON);
      }
    }
  });

  it('never produces an overlap on a full lane', () => {
    const timeline = createLinearTimeline();
    for (const edge of ['in', 'out'] as const) {
      for (let frames = -400; frames <= 400; frames += 1) {
        const { timeline: next } = trimClip(timeline, 'b', edge, frames * FRAME);
        const [a, b, c] = [getClip(next, 'a')!, getClip(next, 'b')!, getClip(next, 'c')!];
        expect(b.start).toBeGreaterThanOrEqual(clipEnd(a) - TIME_EPSILON);
        expect(clipEnd(b)).toBeLessThanOrEqual(c.start + TIME_EPSILON);
      }
    }
  });
});
