import { describe, expect, it } from 'vitest';

import {
  DEFAULT_PEAK_COLUMNS,
  PEAK_VIEW_HEIGHT,
  PEAK_VIEW_WIDTH,
  downsamplePeaks,
  peakEnvelopePath,
} from './waveformPeaks';

/** A deterministic pseudo-signal: no randomness in a test that asserts extremes. */
function signal(length: number): number[] {
  return Array.from({ length }, (_, index) => Math.sin((index / length) * Math.PI * 8));
}

describe('downsamplePeaks — the four sample-count cases', () => {
  it('empty input yields no columns at all', () => {
    expect(downsamplePeaks([], 64)).toEqual([]);
    expect(downsamplePeaks(new Float32Array(0), 64)).toEqual([]);
  });

  it('N < W repeats the nearest sample rather than leaving holes', () => {
    const columns = downsamplePeaks([-1, 0, 1], 6);
    expect(columns).toHaveLength(6);
    // Every column is a real measurement, and each sample is used.
    expect(columns).toEqual([
      { min: -1, max: -1 },
      { min: -1, max: -1 },
      { min: 0, max: 0 },
      { min: 0, max: 0 },
      { min: 1, max: 1 },
      { min: 1, max: 1 },
    ]);
  });

  it('N == W gives one sample per column, so min equals max', () => {
    const samples = signal(32);
    const columns = downsamplePeaks(samples, 32);
    expect(columns).toHaveLength(32);
    for (const [index, column] of columns.entries()) {
      expect(column.min).toBe(samples[index]);
      expect(column.max).toBe(samples[index]);
    }
  });

  it('N far greater than W keeps the extremes of every bucket', () => {
    const samples = signal(10_000);
    const columns = downsamplePeaks(samples, 10);
    expect(columns).toHaveLength(10);

    for (const [index, column] of columns.entries()) {
      const bucket = samples.slice(index * 1000, (index + 1) * 1000);
      expect(column.min).toBe(Math.min(...bucket));
      expect(column.max).toBe(Math.max(...bucket));
    }
    // Nothing is lost: the loudest sample survives into some column.
    expect(Math.max(...columns.map((column) => column.max))).toBe(Math.max(...samples));
    expect(Math.min(...columns.map((column) => column.min))).toBe(Math.min(...samples));
  });
});

describe('downsamplePeaks — edges', () => {
  it('covers every sample exactly once when the count divides evenly', () => {
    const samples = [0, 1, 2, 3, 4, 5, 6, 7];
    expect(downsamplePeaks(samples, 4)).toEqual([
      { min: 0, max: 1 },
      { min: 2, max: 3 },
      { min: 4, max: 5 },
      { min: 6, max: 7 },
    ]);
  });

  it('handles a count that does not divide evenly without dropping the tail', () => {
    const columns = downsamplePeaks([0, 1, 2, 3, 4, 5, 6], 3);
    expect(columns).toHaveLength(3);
    expect(columns[2]?.max).toBe(6);
  });

  it('accepts a Float32Array as readily as an array', () => {
    const columns = downsamplePeaks(Float32Array.from([-0.5, 0.5]), 2);
    expect(columns).toEqual([
      { min: -0.5, max: -0.5 },
      { min: 0.5, max: 0.5 },
    ]);
  });

  it('refuses a non-positive or non-finite column count', () => {
    expect(downsamplePeaks([1, 2, 3], 0)).toEqual([]);
    expect(downsamplePeaks([1, 2, 3], -4)).toEqual([]);
    expect(downsamplePeaks([1, 2, 3], Number.NaN)).toEqual([]);
  });

  it('skips a non-finite sample instead of poisoning its column', () => {
    expect(downsamplePeaks([Number.NaN, 0.4, 0.2], 1)).toEqual([{ min: 0.2, max: 0.4 }]);
    // A column made only of them is silence, not NaN.
    expect(downsamplePeaks([Number.NaN, Number.NaN], 1)).toEqual([{ min: 0, max: 0 }]);
  });

  it('produces one column per requested column at the default width', () => {
    expect(downsamplePeaks(signal(44_100), DEFAULT_PEAK_COLUMNS)).toHaveLength(DEFAULT_PEAK_COLUMNS);
  });
});

describe('peakEnvelopePath', () => {
  it('is empty when there is nothing to draw', () => {
    expect(peakEnvelopePath([])).toBe('');
  });

  it('maps a full-scale column to the top and bottom of the box', () => {
    const path = peakEnvelopePath(
      [
        { min: -1, max: 1 },
        { min: -1, max: 1 },
      ],
      { width: 100, height: 100 },
    );
    expect(path).toBe('M0,0 L100,0 L100,100 L0,100 Z');
  });

  it('puts silence on the centre line', () => {
    const path = peakEnvelopePath(
      [
        { min: 0, max: 0 },
        { min: 0, max: 0 },
      ],
      { width: 10, height: 100 },
    );
    expect(path).toBe('M0,50 L10,50 L10,50 L0,50 Z');
  });

  it('clamps an over-driven sample to the box instead of escaping it', () => {
    const path = peakEnvelopePath(
      [
        { min: -4, max: 4 },
        { min: -4, max: 4 },
      ],
      { width: 100, height: 100 },
    );
    expect(path).toBe('M0,0 L100,0 L100,100 L0,100 Z');
  });

  it('draws a single column as one stroke rather than a degenerate loop', () => {
    expect(peakEnvelopePath([{ min: -1, max: 1 }], { width: 100, height: 100 })).toBe('M0,0 L0,100');
  });

  it('defaults to the artboard view box', () => {
    const path = peakEnvelopePath([
      { min: -1, max: 1 },
      { min: -1, max: 1 },
    ]);
    expect(path).toContain(`L${PEAK_VIEW_WIDTH},0`);
    expect(path).toContain(`L${PEAK_VIEW_WIDTH},${PEAK_VIEW_HEIGHT}`);
  });

  it('rounds coordinates so the same input always prints the same path', () => {
    const columns = downsamplePeaks(signal(1000), 7);
    expect(peakEnvelopePath(columns)).toBe(peakEnvelopePath(columns));
    expect(peakEnvelopePath(columns)).not.toMatch(/\d\.\d{3}/u);
  });
});
