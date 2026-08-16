import { describe, expect, it } from 'vitest';

import {
  ceilToFrame,
  floorToFrame,
  frameAt,
  frameDuration,
  isOnFrame,
  quantizeClip,
  quantizeTimeline,
  quantizeToFrame,
} from './frameGrid';
import { razorAt } from './razor';
import { createLinearTimeline, createSampleTimeline } from './sampleTimeline';
import { clipEnd, clipSourceOut, createTimeline, getClip, type Clip } from './timelineModel';
import { TIME_EPSILON } from './timeScale';

const AT_60 = 60;

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

describe('the grid itself', () => {
  it('rounds to the nearest frame', () => {
    expect(quantizeToFrame(0.008, AT_60)).toBe(0);
    expect(quantizeToFrame(0.009, AT_60)).toBeCloseTo(1 / 60, 12);
    expect(frameAt(42.167, AT_60)).toBe(2530);
    expect(frameDuration(AT_60)).toBeCloseTo(0.016_666_666, 8);
  });

  it('floors and ceils to a frame', () => {
    expect(floorToFrame(0.99 / 60, AT_60)).toBe(0);
    expect(ceilToFrame(0.01 / 60, AT_60)).toBeCloseTo(1 / 60, 12);
    // Already on a frame: neither direction may move it, or a value would
    // creep one frame per pass through the operation that calls this.
    expect(floorToFrame(3 / 60, AT_60)).toBeCloseTo(3 / 60, 12);
    expect(ceilToFrame(3 / 60, AT_60)).toBeCloseTo(3 / 60, 12);
  });

  it('does not drift at the far end of a long sequence', () => {
    // The reason `quantizeToFrame` counts in frames rather than multiplying by
    // a step: an hour in, `Math.round(t / 0.016666…) * 0.016666…` is off by
    // enough to fail `isOnFrame`.
    const anHourIn = 3600 + 17 / 60;
    const quantized = quantizeToFrame(anHourIn, AT_60);
    expect(isOnFrame(quantized, AT_60)).toBe(true);
    expect(frameAt(quantized, AT_60)).toBe(216_017);
  });

  it('recognises a time already on the grid at any rate', () => {
    for (const fps of [24, 25, 30, 50, 60, 120, 144]) {
      for (const frame of [0, 1, 7, 999]) {
        expect(isOnFrame(frame / fps, fps)).toBe(true);
      }
      expect(isOnFrame(0.5 / fps, fps)).toBe(false);
    }
  });
});

describe('quantizeClip', () => {
  it('puts start, duration and the in point on frames', () => {
    const quantized = quantizeClip(clip({ id: 'a', start: 1.001, duration: 3.999, sourceIn: 0.004 }), AT_60);
    expect(isOnFrame(quantized.start, AT_60)).toBe(true);
    expect(isOnFrame(quantized.duration, AT_60)).toBe(true);
    expect(isOnFrame(quantized.sourceIn, AT_60)).toBe(true);
  });

  it('never rounds a clip out of existence', () => {
    // A third of a frame would round to zero, and `createTimeline` refuses a
    // zero-length clip — a refusal the operation should have made, not a throw.
    const quantized = quantizeClip(clip({ id: 'a', duration: 0.004 }), AT_60);
    expect(quantized.duration).toBeCloseTo(1 / 60, 12);
  });

  it('leaves speed alone', () => {
    // A ratio is not a time. Forcing `duration * speed` onto the grid too
    // would mean no clip could run at 1.5×.
    expect(quantizeClip(clip({ id: 'a', speed: 1.5 }), AT_60).speed).toBe(1.5);
  });
});

describe('quantizeTimeline', () => {
  it('moves everything onto the grid, the playhead included', () => {
    const quantized = quantizeTimeline(createSampleTimeline());
    for (const each of quantized.clips) {
      expect(isOnFrame(each.start, AT_60)).toBe(true);
      expect(isOnFrame(each.duration, AT_60)).toBe(true);
    }
    for (const marker of quantized.markers) expect(isOnFrame(marker.time, AT_60)).toBe(true);
    expect(isOnFrame(quantized.playhead, AT_60)).toBe(true);
  });

  it('leaves a document that is already on the grid untouched', () => {
    const once = quantizeTimeline(createSampleTimeline());
    expect(quantizeTimeline(once)).toEqual(once);
  });

  it('always produces a document createTimeline accepts', () => {
    // The contract: this runs between an operation and the undo stack, so a
    // result it cannot build would crash on the next render rather than at a
    // point anyone could attribute.
    const quantized = quantizeTimeline(createSampleTimeline());
    expect(() => createTimeline(quantized)).not.toThrow();
  });

  it('keeps a cut seamless', () => {
    // The invariant the whole module exists for: after a razor at an arbitrary
    // instant the left half's end and the right half's start are the same
    // number, not two numbers that agree to six places.
    const cut = quantizeTimeline(razorAt(quantizeTimeline(createSampleTimeline()), 31.171).timeline);
    const left = getClip(cut, 'v1-kael');
    const right = getClip(cut, 'v1-kael~2');
    expect(clipEnd(left!)).toBe(right!.start);
    // …and the source is continuous across it, which is the other half of a
    // cut that does not jump.
    expect(clipSourceOut(left!)).toBeCloseTo(right!.sourceIn, 12);
  });

  it('slides a window back rather than shortening it when rounding overruns', () => {
    // The window ends 6μs short of the media. Rounding takes `duration` from
    // 9.996 up to 10 and `sourceIn` from 0.02 down to frame 1, which together
    // overrun. Sliding the in point to zero is invisible — the same material,
    // one frame earlier — where shortening would cost a frame every time the
    // document was quantised, and a clip that erodes on every gesture is a bug
    // nobody would attribute to rounding.
    const timeline = quantizeTimeline(
      createTimeline({
        tracks: [{ id: 'v1', kind: 'video', name: 'V1', role: '主画面' }],
        clips: [clip({ id: 'a', start: 0, duration: 9.996, sourceIn: 0.02, sourceDuration: 10.0166 })],
      }),
    );
    const only = timeline.clips[0]!;
    expect(only.duration).toBeCloseTo(quantizeToFrame(9.996, AT_60), 12);
    expect(only.sourceIn).toBe(0);
    expect(clipSourceOut(only)).toBeLessThanOrEqual(only.sourceDuration + TIME_EPSILON);
  });

  it('gives up a frame of duration only when there is no window left to slide', () => {
    // The in point is already zero, so the second step is the only one left.
    const timeline = quantizeTimeline(
      createTimeline({
        tracks: [{ id: 'v1', kind: 'video', name: 'V1', role: '主画面' }],
        clips: [clip({ id: 'a', start: 0, duration: 5.999, sourceIn: 0, sourceDuration: 5.999 })],
      }),
    );
    const only = timeline.clips[0]!;
    expect(only.sourceIn).toBe(0);
    expect(clipSourceOut(only)).toBeLessThanOrEqual(only.sourceDuration + TIME_EPSILON);
    expect(() => createTimeline(timeline)).not.toThrow();
  });

  it('respects the document’s own frame rate', () => {
    // 1.02s is frame 24.48 at 24fps and frame 61.2 at 60fps, so the two rates
    // round it to different instants. The grid is the project's, not a
    // constant — `EditorProject.fps` is what a 1080p60 capture and a 24fps
    // delivery differ by.
    const at24 = createTimeline({ ...createLinearTimeline(), fps: 24 });
    expect(quantizeTimeline({ ...at24, playhead: 1.02 }).playhead).toBe(1);
    expect(quantizeToFrame(1.02, 60)).toBeCloseTo(61 / 60, 12);
  });
});
