import { describe, expect, it } from 'vitest';

import {
  DEFAULT_FPS,
  clampTime,
  formatRate,
  frameDuration,
  frameIndexAt,
  progressPercent,
  progressRatio,
  stepFrames,
} from './transportModel';

describe('clampTime', () => {
  it('keeps a time inside the media', () => {
    expect(clampTime(5, 42)).toBe(5);
    expect(clampTime(-3, 42)).toBe(0);
    expect(clampTime(99, 42)).toBe(42);
  });

  it('collapses to zero when there is no media', () => {
    expect(clampTime(5, 0)).toBe(0);
    expect(clampTime(5, -1)).toBe(0);
  });

  it('turns a non-finite time into zero rather than propagating it', () => {
    expect(clampTime(Number.NaN, 42)).toBe(0);
    expect(clampTime(Number.POSITIVE_INFINITY, 42)).toBe(0);
    expect(clampTime(5, Number.NaN)).toBe(0);
  });
});

describe('frameDuration', () => {
  it('is the reciprocal of the rate', () => {
    expect(frameDuration(60)).toBeCloseTo(1 / 60, 12);
    expect(frameDuration(30)).toBeCloseTo(1 / 30, 12);
  });

  it('falls back on a rate that cannot be one', () => {
    expect(frameDuration(0)).toBe(1 / DEFAULT_FPS);
    expect(frameDuration(-30)).toBe(1 / DEFAULT_FPS);
    expect(frameDuration(Number.NaN)).toBe(1 / DEFAULT_FPS);
  });
});

describe('frameIndexAt', () => {
  it('counts whole frames', () => {
    expect(frameIndexAt(0, 60)).toBe(0);
    expect(frameIndexAt(1, 60)).toBe(60);
    expect(frameIndexAt(0.5, 60)).toBe(30);
  });

  it('does not let float slack push a time back a frame', () => {
    // 12 frames at 60fps stored as a float lands a hair under 0.2.
    expect(frameIndexAt(12 / 60 - 1e-9, 60)).toBe(12);
  });

  it('is zero before the start', () => {
    expect(frameIndexAt(-1, 60)).toBe(0);
    expect(frameIndexAt(Number.NaN, 60)).toBe(0);
  });
});

describe('stepFrames', () => {
  const options = { fps: 60, durationSeconds: 10 };

  it('moves one frame either way', () => {
    expect(stepFrames(1, 1, options)).toBeCloseTo(61 / 60, 12);
    expect(stepFrames(1, -1, options)).toBeCloseTo(59 / 60, 12);
  });

  it('clamps at both ends instead of refusing', () => {
    expect(stepFrames(0, -1, options)).toBe(0);
    expect(stepFrames(10, 1, options)).toBe(10);
  });

  it('does not drift over many steps', () => {
    let time = 0;
    for (let index = 0; index < 600; index += 1) time = stepFrames(time, 1, options);
    expect(frameIndexAt(time, 60)).toBe(600);
    expect(time).toBeCloseTo(10, 9);
  });

  it('takes a multi-frame jump in one go', () => {
    expect(frameIndexAt(stepFrames(1, 10, options), 60)).toBe(70);
    expect(frameIndexAt(stepFrames(1, -10, options), 60)).toBe(50);
  });

  it('treats a zero or non-finite step as a clamp only', () => {
    expect(stepFrames(3, 0, options)).toBe(3);
    expect(stepFrames(99, 0, options)).toBe(10);
    expect(stepFrames(3, Number.NaN, options)).toBe(3);
  });
});

describe('progressRatio', () => {
  it('is the fraction travelled', () => {
    expect(progressRatio(0, 42)).toBe(0);
    expect(progressRatio(21, 42)).toBe(0.5);
    expect(progressRatio(42, 42)).toBe(1);
  });

  it('never divides by a duration that is not there', () => {
    expect(progressRatio(5, 0)).toBe(0);
    expect(progressRatio(5, Number.NaN)).toBe(0);
  });

  it('clamps rather than running past the end', () => {
    expect(progressRatio(99, 42)).toBe(1);
    expect(progressRatio(-9, 42)).toBe(0);
  });
});

describe('progressPercent', () => {
  it('prints a stable, unpadded percentage', () => {
    expect(progressPercent(21, 42)).toBe('50%');
    expect(progressPercent(0, 42)).toBe('0%');
    expect(progressPercent(42, 42)).toBe('100%');
  });

  it('rounds a repeating fraction instead of spilling it into the DOM', () => {
    expect(progressPercent(1, 3)).toBe('33.3333%');
  });
});

describe('formatRate', () => {
  it('spells a rate the way the artboard does', () => {
    expect(formatRate(1)).toBe('1×');
    expect(formatRate(0.25)).toBe('0.25×');
    expect(formatRate(2)).toBe('2×');
  });

  it('falls back rather than printing NaN×', () => {
    expect(formatRate(Number.NaN)).toBe('1×');
  });
});
