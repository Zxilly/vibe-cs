import { describe, expect, it } from 'vitest';

import { createSampleTimeline } from './sampleTimeline';
import { groupSlipRange, slipClip, slipPreview } from './slip';
import { clipSourceOut, createTimeline, getClip, slipRange, type Clip, type Timeline } from './timelineModel';

function pair(overrides: { videoSource?: number; audioSource?: number; sourceIn?: number } = {}): Timeline {
  const { videoSource = 20, audioSource = 20, sourceIn = 5 } = overrides;
  return createTimeline({
    tracks: [
      { id: 'v1', kind: 'video', name: 'V1', role: '主画面' },
      { id: 'a1', kind: 'audio', name: 'A1', role: '原声' },
    ],
    clips: [
      { id: 'v', trackId: 'v1', start: 10, duration: 4, sourceIn, sourceDuration: videoSource, label: 'v', linkId: 'g' },
      { id: 'a', trackId: 'a1', start: 10, duration: 4, sourceIn, sourceDuration: audioSource, label: 'a', linkId: 'g' },
    ],
  });
}

describe('slipClip', () => {
  it('moves the source window and nothing else', () => {
    const before = getClip(createSampleTimeline(), 'v1-aurora')!;
    const { timeline, applied, appliedDelta } = slipClip(createSampleTimeline(), 'v1-aurora', 2);
    const after = getClip(timeline, 'v1-aurora')!;

    expect(applied).toBe(true);
    expect(appliedDelta).toBe(2);
    // The whole of 滑移: position on the timeline is invariant.
    expect(after.start).toBe(before.start);
    expect(after.duration).toBe(before.duration);
    expect(after.trackId).toBe(before.trackId);
    // …and the in and out points move together, keeping the length.
    expect(after.sourceIn).toBeCloseTo(before.sourceIn + 2, 9);
    expect(clipSourceOut(after)).toBeCloseTo(clipSourceOut(before) + 2, 9);
    expect(clipSourceOut(after) - after.sourceIn).toBeCloseTo(after.duration, 9);
  });

  it('slips backwards too', () => {
    const { timeline, appliedDelta } = slipClip(createSampleTimeline(), 'v1-aurora', -2);
    expect(appliedDelta).toBe(-2);
    expect(getClip(timeline, 'v1-aurora')!.sourceIn).toBeCloseTo(2.133, 6);
  });

  it('clamps at the head of the source rather than refusing', () => {
    // 4.133s of head is all there is; asking for 100 gets 4.133.
    const { timeline, applied, appliedDelta } = slipClip(createSampleTimeline(), 'v1-aurora', -100);
    expect(applied).toBe(true);
    expect(appliedDelta).toBeCloseTo(-4.133, 9);
    expect(getClip(timeline, 'v1-aurora')!.sourceIn).toBeCloseTo(0, 9);
  });

  it('clamps at the tail of the source', () => {
    const { timeline, appliedDelta } = slipClip(createSampleTimeline(), 'v1-aurora', 100);
    const after = getClip(timeline, 'v1-aurora')!;
    expect(appliedDelta).toBeCloseTo(3.867, 6);
    expect(clipSourceOut(after)).toBeCloseTo(after.sourceDuration, 6);
  });

  it('never shows a frame that does not exist, however hard it is pushed', () => {
    let timeline = createSampleTimeline();
    for (const delta of [5, -20, 100, -100, 0.001, 40]) {
      timeline = slipClip(timeline, 'v1-aurora', delta).timeline;
      const clip = getClip(timeline, 'v1-aurora')!;
      expect(clip.sourceIn).toBeGreaterThanOrEqual(-1e-9);
      expect(clipSourceOut(clip)).toBeLessThanOrEqual(clip.sourceDuration + 1e-9);
      expect(clip.start).toBeCloseTo(42.167, 9);
      expect(clip.duration).toBe(28);
    }
  });

  it('refuses a clip with no headroom at all', () => {
    // 名牌 · Kael is exactly as long as its source.
    const before = createSampleTimeline();
    const result = slipClip(before, 'v2-kael', 1);
    expect(result.applied).toBe(false);
    expect(result.reason).toBe('no-headroom');
    expect(result.timeline).toBe(before);
    expect(result.range.min).toBeCloseTo(0, 9);
    expect(result.range.max).toBeCloseTo(0, 9);
  });

  it('refuses a zero slip, an unknown clip and a locked lane', () => {
    expect(slipClip(createSampleTimeline(), 'v1-aurora', 0).reason).toBe('no-headroom');
    expect(slipClip(createSampleTimeline(), 'nope', 1).reason).toBe('unknown-clip');

    const locked = createTimeline({
      tracks: [{ id: 'v1', kind: 'video', name: 'V1', role: '主画面', locked: true }],
      clips: [{ id: 'a', trackId: 'v1', start: 0, duration: 4, sourceIn: 2, sourceDuration: 10, label: 'a' }],
    });
    expect(slipClip(locked, 'a', 1).reason).toBe('track-locked');
  });

  it('reports the headroom that is left', () => {
    const { range } = slipClip(createSampleTimeline(), 'v1-aurora', 2);
    expect(range.min).toBeCloseTo(-6.133, 6);
    expect(range.max).toBeCloseTo(1.867, 6);
  });

  it('does not mutate its input', () => {
    const base = createSampleTimeline();
    const before = JSON.stringify(base);
    slipClip(base, 'v1-aurora', 2);
    expect(JSON.stringify(base)).toBe(before);
  });
});

describe('slipping a link group', () => {
  it('slips the A/V pair by the same amount', () => {
    const { timeline } = slipClip(pair(), 'v', 3);
    expect(getClip(timeline, 'v')!.sourceIn).toBe(8);
    expect(getClip(timeline, 'a')!.sourceIn).toBe(8);
  });

  it('is limited by the most constrained member, so the pair cannot desync', () => {
    // The video has 11s of tail, the audio only 1s: 1s is what both get.
    const { timeline, appliedDelta } = slipClip(pair({ videoSource: 20, audioSource: 10 }), 'v', 5);
    expect(appliedDelta).toBe(1);
    expect(getClip(timeline, 'v')!.sourceIn).toBe(6);
    expect(getClip(timeline, 'a')!.sourceIn).toBe(6);
    expect(clipSourceOut(getClip(timeline, 'a')!)).toBe(10);
  });

  it('refuses when one member has no headroom, rather than desyncing the other', () => {
    // The audio is exactly its source: the group cannot slip at all.
    const timeline = pair({ audioSource: 4, sourceIn: 0 });
    expect(slipClip(timeline, 'v', 2).applied).toBe(false);
  });

  it('slips only the addressed clip when the link is ignored', () => {
    const { timeline } = slipClip(pair(), 'v', 3, { linked: false });
    expect(getClip(timeline, 'v')!.sourceIn).toBe(8);
    expect(getClip(timeline, 'a')!.sourceIn).toBe(5);
  });

  it('can be driven from either end of the pair', () => {
    expect(slipClip(pair(), 'a', 3).timeline.clips.map((clip) => clip.sourceIn)).toEqual([8, 8]);
  });
});

describe('groupSlipRange', () => {
  it('intersects the members’ ranges', () => {
    const clips: Clip[] = [
      { id: 'v', trackId: 'v1', start: 0, duration: 4, sourceIn: 5, sourceDuration: 20, label: 'v' },
      { id: 'a', trackId: 'a1', start: 0, duration: 4, sourceIn: 2, sourceDuration: 10, label: 'a' },
    ];
    expect(groupSlipRange(clips)).toEqual({ min: -2, max: 4 });
  });

  it('equals the single clip’s range for a group of one', () => {
    const clip: Clip = { id: 'v', trackId: 'v1', start: 0, duration: 4, sourceIn: 5, sourceDuration: 20, label: 'v' };
    expect(groupSlipRange([clip])).toEqual(slipRange(clip));
  });

  it('is empty for an empty group', () => {
    expect(groupSlipRange([])).toEqual({ min: 0, max: 0 });
  });
});

describe('slipPreview', () => {
  it('prints the two Inspector timecodes for a slip in progress', () => {
    const clip = getClip(createSampleTimeline(), 'v1-aurora')!;
    const preview = slipPreview(clip, 1);
    expect(preview.sourceIn).toBeCloseTo(5.133, 6);
    expect(preview.sourceOut).toBeCloseTo(33.133, 6);
  });

  it('clamps like the edit it previews', () => {
    const clip = getClip(createSampleTimeline(), 'v1-aurora')!;
    expect(slipPreview(clip, -100).sourceIn).toBeCloseTo(0, 9);
    expect(slipPreview(clip, 100).sourceOut).toBeCloseTo(36, 9);
  });
});
