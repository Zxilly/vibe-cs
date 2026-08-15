import { describe, expect, it } from 'vitest';

import { isRovingKey, nextRovingIndex, ROVING_KEYS, rovingTabIndex } from './rovingIndex';

describe('isRovingKey', () => {
  it('recognises exactly the six movement keys', () => {
    for (const key of ROVING_KEYS) expect(isRovingKey(key)).toBe(true);
    for (const key of ['Enter', ' ', 'Tab', 'a', 'Escape', 'PageDown']) expect(isRovingKey(key)).toBe(false);
  });
});

describe('nextRovingIndex', () => {
  it('moves forward on both forward keys and wraps at the end', () => {
    expect(nextRovingIndex(0, 'ArrowDown', 3)).toBe(1);
    expect(nextRovingIndex(0, 'ArrowRight', 3)).toBe(1);
    expect(nextRovingIndex(2, 'ArrowDown', 3)).toBe(0);
  });

  it('moves backward on both backward keys and wraps at the start', () => {
    expect(nextRovingIndex(2, 'ArrowUp', 3)).toBe(1);
    expect(nextRovingIndex(2, 'ArrowLeft', 3)).toBe(1);
    expect(nextRovingIndex(0, 'ArrowUp', 3)).toBe(2);
  });

  it('jumps to the ends', () => {
    expect(nextRovingIndex(1, 'Home', 3)).toBe(0);
    expect(nextRovingIndex(1, 'End', 3)).toBe(2);
  });

  it('enters the list from either end when nothing is selected', () => {
    expect(nextRovingIndex(-1, 'ArrowDown', 3)).toBe(0);
    expect(nextRovingIndex(-1, 'ArrowUp', 3)).toBe(2);
  });

  it('declines keys it does not own, so the caller knows not to preventDefault', () => {
    expect(nextRovingIndex(0, 'Enter', 3)).toBeNull();
    expect(nextRovingIndex(0, 'Tab', 3)).toBeNull();
  });

  it('declines to move through nothing', () => {
    expect(nextRovingIndex(0, 'ArrowDown', 0)).toBeNull();
    expect(nextRovingIndex(0, 'ArrowDown', Number.NaN)).toBeNull();
  });

  it('stays inside the list for every start, key and size up to five', () => {
    for (let count = 1; count <= 5; count += 1) {
      for (let current = -1; current < count; current += 1) {
        for (const key of ROVING_KEYS) {
          const next = nextRovingIndex(current, key, count);
          expect(next).not.toBeNull();
          expect(next as number).toBeGreaterThanOrEqual(0);
          expect(next as number).toBeLessThan(count);
        }
      }
    }
  });

  it('is reversible: a step forward and a step back returns to the start', () => {
    for (let count = 2; count <= 6; count += 1) {
      for (let current = 0; current < count; current += 1) {
        const forward = nextRovingIndex(current, 'ArrowDown', count) as number;
        expect(nextRovingIndex(forward, 'ArrowUp', count)).toBe(current);
      }
    }
  });
});

describe('rovingTabIndex', () => {
  it('gives the tab stop to the selected item', () => {
    expect(rovingTabIndex(0, 2)).toBe(-1);
    expect(rovingTabIndex(2, 2)).toBe(0);
  });

  it('gives it to the first item when nothing is selected, so the group stays reachable', () => {
    expect(rovingTabIndex(0, -1)).toBe(0);
    expect(rovingTabIndex(1, -1)).toBe(-1);
  });

  it('hands out exactly one tab stop for any selection', () => {
    for (let active = -1; active < 4; active += 1) {
      const stops = [0, 1, 2, 3].filter((index) => rovingTabIndex(index, active) === 0);
      expect(stops).toHaveLength(1);
    }
  });
});
