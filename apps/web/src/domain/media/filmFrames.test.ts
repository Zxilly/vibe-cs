import { describe, expect, it } from 'vitest';

import { evenFrameTimes, frameIndexAtTime, placeholderFrames } from './filmFrames';

describe('evenFrameTimes', () => {
  it('starts at zero and steps by duration / count', () => {
    expect(evenFrameTimes(40, 4)).toEqual([0, 10, 20, 30]);
  });

  it('never reaches the end — the last cell begins one step short of it', () => {
    const times = evenFrameTimes(42, 7);
    expect(times).toHaveLength(7);
    expect(times[0]).toBe(0);
    expect(times.at(-1)).toBe(36);
    for (const time of times) expect(time).toBeLessThan(42);
  });

  it('does not drift on a duration that does not divide evenly', () => {
    const times = evenFrameTimes(10, 3);
    expect(times).toEqual([0, 3.333333, 6.666667]);
  });

  it('is empty when there is no media or no room for a cell', () => {
    expect(evenFrameTimes(0, 8)).toEqual([]);
    expect(evenFrameTimes(-5, 8)).toEqual([]);
    expect(evenFrameTimes(Number.NaN, 8)).toEqual([]);
    expect(evenFrameTimes(40, 0)).toEqual([]);
    expect(evenFrameTimes(40, -3)).toEqual([]);
    expect(evenFrameTimes(40, Number.NaN)).toEqual([]);
  });

  it('is ascending for every count from 1 to 64', () => {
    for (let count = 1; count <= 64; count += 1) {
      const times = evenFrameTimes(124, count);
      expect(times).toHaveLength(count);
      for (let index = 1; index < times.length; index += 1) {
        expect(times[index] as number).toBeGreaterThan(times[index - 1] as number);
      }
    }
  });
});

describe('placeholderFrames', () => {
  it('carries the times and no image', () => {
    expect(placeholderFrames(30, 3)).toEqual([{ time: 0 }, { time: 10 }, { time: 20 }]);
  });

  it('is empty when there is nothing to place', () => {
    expect(placeholderFrames(0, 6)).toEqual([]);
  });
});

describe('frameIndexAtTime', () => {
  const times = evenFrameTimes(40, 4); // 0, 10, 20, 30

  it('takes the cell a time is inside, not the nearest one', () => {
    expect(frameIndexAtTime(times, 0)).toBe(0);
    expect(frameIndexAtTime(times, 9.9)).toBe(0);
    expect(frameIndexAtTime(times, 10)).toBe(1);
    expect(frameIndexAtTime(times, 19.999)).toBe(1);
    expect(frameIndexAtTime(times, 30)).toBe(3);
    expect(frameIndexAtTime(times, 39.5)).toBe(3);
  });

  it('does not let float slack land a boundary in the previous cell', () => {
    expect(frameIndexAtTime(times, 10 - 1e-9)).toBe(1);
  });

  it('clamps before the first cell and after the last', () => {
    expect(frameIndexAtTime(times, -12)).toBe(0);
    expect(frameIndexAtTime(times, 9_999)).toBe(3);
  });

  it('has nothing to point at in an empty strip', () => {
    expect(frameIndexAtTime([], 4)).toBe(-1);
  });

  it('takes the first cell rather than propagating a non-finite time', () => {
    expect(frameIndexAtTime(times, Number.NaN)).toBe(0);
  });
});
