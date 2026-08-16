import { describe, expect, it } from 'vitest';

import { frameDuration } from './frameGrid';
import { durationAtSpeed, setClipSpeed, speedToFit } from './speed';
import { createLinearTimeline } from './sampleTimeline';
import { clipSourceOut, createTimeline, getClip, type Timeline } from './timelineModel';

const FRAME = frameDuration(60);

/** One clip alone, 4s of timeline from 4s of source. */
function solo(): Timeline {
  return createTimeline({
    tracks: [{ id: 'v1', kind: 'video', name: 'V1', role: '主画面' }],
    clips: [{ id: 'a', trackId: 'v1', start: 10, duration: 4, sourceIn: 3, sourceDuration: 20, label: 'A' }],
  });
}

function pair(): Timeline {
  return createTimeline({
    tracks: [
      { id: 'v1', kind: 'video', name: 'V1', role: '主画面' },
      { id: 'a1', kind: 'audio', name: 'A1', role: '原声' },
    ],
    clips: [
      { id: 'v', trackId: 'v1', start: 0, duration: 4, sourceIn: 0, sourceDuration: 20, label: 'V', linkId: 'p' },
      { id: 'a', trackId: 'a1', start: 0, duration: 4, sourceIn: 0, sourceDuration: 20, label: 'A', linkId: 'p' },
    ],
  });
}

describe('setClipSpeed', () => {
  it('keeps the source window and changes the duration', () => {
    // The whole decision of the module: 200% still shows the same 4s of
    // footage, in 2s. Keeping `duration` instead would drop half the shot.
    const { timeline, applied, appliedSpeed } = setClipSpeed(solo(), 'a', 2);
    const clip = getClip(timeline, 'a')!;
    expect(applied).toBe(true);
    expect(appliedSpeed).toBe(2);
    expect(clip.duration).toBe(2);
    expect(clip.sourceIn).toBe(3);
    expect(clipSourceOut(clip)).toBe(7);
  });

  it('lengthens a clip below 100%', () => {
    expect(getClip(setClipSpeed(solo(), 'a', 0.5).timeline, 'a')!.duration).toBe(8);
  });

  it('does not move the clip’s left edge', () => {
    expect(getClip(setClipSpeed(solo(), 'a', 4).timeline, 'a')!.start).toBe(10);
  });

  it('round-trips', () => {
    const doubled = setClipSpeed(solo(), 'a', 2).timeline;
    expect(getClip(setClipSpeed(doubled, 'a', 1).timeline, 'a')).toEqual(getClip(solo(), 'a'));
  });

  it('refuses a speed the document would reject', () => {
    // `EditorProject::validate` bounds speed to 0.05…16. Refusing here means
    // the user hears about it at the field, not as a 400 several seconds later.
    for (const speed of [0, 0.04, 16.1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const result = setClipSpeed(solo(), 'a', speed);
      expect(result.applied).toBe(false);
      expect(result.reason).toBe('speed-out-of-range');
    }
    expect(setClipSpeed(solo(), 'a', 0.05).applied).toBe(true);
    expect(setClipSpeed(solo(), 'a', 16).applied).toBe(true);
  });

  it('refuses when the longer clip would collide', () => {
    // A[0,4) B[4,8) C[8,12): halving B's speed would take it to 12s.
    const refused = setClipSpeed(createLinearTimeline(), 'b', 0.5);
    expect(refused.applied).toBe(false);
    expect(refused.reason).toBe('overlap');
    // The last clip has nothing to its right, so the same change is fine.
    expect(setClipSpeed(createLinearTimeline(), 'c', 0.5).applied).toBe(true);
  });

  it('refuses when the faster clip would be shorter than a frame', () => {
    const short = createTimeline({
      tracks: [{ id: 'v1', kind: 'video', name: 'V1', role: '主画面' }],
      clips: [
        { id: 'a', trackId: 'v1', start: 0, duration: 2 * FRAME, sourceIn: 0, sourceDuration: 10, label: 'A' },
      ],
    });
    const refused = setClipSpeed(short, 'a', 16);
    expect(refused.applied).toBe(false);
    expect(refused.reason).toBe('too-short');
  });

  it('refuses a locked track and an unknown clip', () => {
    const locked = createTimeline({
      tracks: [{ id: 'v1', kind: 'video', name: 'V1', role: '主画面', locked: true }],
      clips: [{ id: 'a', trackId: 'v1', start: 0, duration: 4, sourceIn: 0, sourceDuration: 10, label: 'A' }],
    });
    expect(setClipSpeed(locked, 'a', 2).reason).toBe('track-locked');
    expect(setClipSpeed(solo(), 'nope', 2).reason).toBe('unknown-clip');
  });

  it('reports no-change rather than rewriting the document', () => {
    const result = setClipSpeed(solo(), 'a', 1);
    expect(result.applied).toBe(false);
    expect(result.reason).toBe('no-change');
    expect(result.timeline).toEqual(solo());
  });
});

describe('setClipSpeed — the link group', () => {
  it('changes both halves so they stay in sync', () => {
    const { timeline } = setClipSpeed(pair(), 'v', 2);
    expect(getClip(timeline, 'v')!.duration).toBe(2);
    expect(getClip(timeline, 'a')!.duration).toBe(2);
    expect(getClip(timeline, 'a')!.speed).toBe(2);
  });

  it('refuses the whole change when one half cannot take it', () => {
    // The audio has a neighbour where the video does not, so slowing the pair
    // is impossible — and half a change would put them out of sync, which is
    // the one thing a linked edit must never produce.
    const blocked = createTimeline({
      tracks: [
        { id: 'v1', kind: 'video', name: 'V1', role: '主画面' },
        { id: 'a1', kind: 'audio', name: 'A1', role: '原声' },
      ],
      clips: [
        { id: 'v', trackId: 'v1', start: 0, duration: 4, sourceIn: 0, sourceDuration: 20, label: 'V', linkId: 'p' },
        { id: 'a', trackId: 'a1', start: 0, duration: 4, sourceIn: 0, sourceDuration: 20, label: 'A', linkId: 'p' },
        { id: 'wall', trackId: 'a1', start: 5, duration: 4, sourceIn: 0, sourceDuration: 20, label: 'W' },
      ],
    });
    const refused = setClipSpeed(blocked, 'v', 0.5);
    expect(refused.applied).toBe(false);
    expect(refused.reason).toBe('overlap');
    expect(getClip(refused.timeline, 'v')!.speed).toBe(1);
  });

  it('changes one alone when asked', () => {
    const { timeline } = setClipSpeed(pair(), 'v', 2, { linked: false });
    expect(getClip(timeline, 'v')!.speed).toBe(2);
    expect(getClip(timeline, 'a')!.speed).toBe(1);
  });
});

describe('durationAtSpeed and speedToFit', () => {
  it('are inverses', () => {
    const clip = getClip(solo(), 'a')!;
    expect(durationAtSpeed(clip, 2)).toBe(2);
    expect(speedToFit(clip, 2)).toBe(2);
    expect(speedToFit(clip, durationAtSpeed(clip, 0.25))).toBe(0.25);
  });

  it('answers null rather than an unusable speed', () => {
    const clip = getClip(solo(), 'a')!;
    expect(speedToFit(clip, 0)).toBeNull();
    expect(speedToFit(clip, -1)).toBeNull();
    // 4s of source stretched over an hour would need 0.001×, below the floor.
    expect(speedToFit(clip, 3600)).toBeNull();
  });
});
