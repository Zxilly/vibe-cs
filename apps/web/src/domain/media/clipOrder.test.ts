import { describe, expect, it } from 'vitest';

import { clampIndex, dropIndex, moveItem, totalDurationSeconds, type TileSpan } from './clipOrder';

const list = ['a', 'b', 'c', 'd', 'e'] as const;

/** Five 210px tiles with a 12px gap, laid out from x = 100. */
function strip(count = 5, width = 210, gap = 12, origin = 100): TileSpan[] {
  return Array.from({ length: count }, (_, index) => {
    const left = origin + index * (width + gap);
    return { left, right: left + width };
  });
}

describe('moveItem', () => {
  it('moves an entry forward, closing the hole behind it', () => {
    expect(moveItem(list, 0, 2)).toEqual(['b', 'c', 'a', 'd', 'e']);
  });

  it('moves an entry backward', () => {
    expect(moveItem(list, 3, 1)).toEqual(['a', 'd', 'b', 'c', 'e']);
  });

  it('moves to either end', () => {
    expect(moveItem(list, 4, 0)).toEqual(['e', 'a', 'b', 'c', 'd']);
    expect(moveItem(list, 0, 4)).toEqual(['b', 'c', 'd', 'e', 'a']);
  });

  it('is a no-op when nothing moves, but still a fresh array', () => {
    const same = moveItem(list, 2, 2);
    expect(same).toEqual([...list]);
    expect(same).not.toBe(list);
  });

  it('never mutates its input', () => {
    const original = [...list];
    moveItem(original, 0, 4);
    expect(original).toEqual([...list]);
  });

  it('clamps a target past either end', () => {
    expect(moveItem(list, 0, 99)).toEqual(['b', 'c', 'd', 'e', 'a']);
    expect(moveItem(list, 4, -99)).toEqual(['e', 'a', 'b', 'c', 'd']);
  });

  it('refuses a source that is not in the list', () => {
    expect(moveItem(list, -1, 0)).toEqual([...list]);
    expect(moveItem(list, 5, 0)).toEqual([...list]);
    expect(moveItem(list, 1.5, 0)).toEqual([...list]);
    expect(moveItem([], 0, 0)).toEqual([]);
  });

  it('round-trips: every move has an inverse', () => {
    for (let from = 0; from < list.length; from += 1) {
      for (let to = 0; to < list.length; to += 1) {
        expect(moveItem(moveItem(list, from, to), to, from)).toEqual([...list]);
      }
    }
  });
});

describe('clampIndex', () => {
  it('folds into range', () => {
    expect(clampIndex(-3, 5)).toBe(0);
    expect(clampIndex(9, 5)).toBe(4);
    expect(clampIndex(2, 5)).toBe(2);
  });

  it('has nowhere to point in an empty list', () => {
    expect(clampIndex(0, 0)).toBe(-1);
  });

  it('takes the start rather than propagating a non-finite index', () => {
    expect(clampIndex(Number.NaN, 5)).toBe(0);
  });
});

describe('dropIndex', () => {
  const spans = strip();

  it('takes the tile the pointer is over', () => {
    expect(dropIndex(spans, 150, 0)).toBe(0);
    expect(dropIndex(spans, 400, 0)).toBe(1);
    expect(dropIndex(spans, 1000, 0)).toBe(4);
  });

  it('sticks to the ends past either edge of the row', () => {
    expect(dropIndex(spans, -500, 3)).toBe(0);
    expect(dropIndex(spans, 99_999, 1)).toBe(4);
  });

  it('resolves a pointer in the gap to the nearer neighbour', () => {
    // The gap between tile 0 (…310) and tile 1 (322…).
    expect(dropIndex(spans, 313, 4)).toBe(0);
    expect(dropIndex(spans, 319, 4)).toBe(1);
  });

  it('is exhaustively consistent with the geometry it was given', () => {
    for (let x = 100; x <= 1210; x += 7) {
      const index = dropIndex(spans, x, 0);
      const span = spans[index] as TileSpan;
      // Either the pointer is inside the tile, or the tile is the closest one.
      const inside = x >= span.left && x <= span.right;
      const distance = Math.min(Math.abs(x - span.left), Math.abs(x - span.right));
      const best = Math.min(...spans.map((s) => Math.min(Math.abs(x - s.left), Math.abs(x - s.right))));
      expect(inside || distance === best).toBe(true);
    }
  });

  it('refuses to move anything when nothing can be measured', () => {
    // jsdom's getBoundingClientRect: every rectangle is zero.
    const flat = Array.from({ length: 5 }, () => ({ left: 0, right: 0 }));
    expect(dropIndex(flat, 0, 3)).toBe(3);
    expect(dropIndex(flat, 500, 3)).toBe(3);
  });

  it('refuses an empty strip or an unmeasurable pointer', () => {
    expect(dropIndex([], 400, 2)).toBe(2);
    expect(dropIndex(spans, Number.NaN, 2)).toBe(2);
  });
});

describe('totalDurationSeconds', () => {
  it('adds the running times up', () => {
    expect(totalDurationSeconds([{ durationSeconds: 42 }, { durationSeconds: 18.4 }])).toBeCloseTo(60.4, 9);
  });

  it('is zero for an empty strip', () => {
    expect(totalDurationSeconds([])).toBe(0);
  });

  it('treats a non-finite duration as nothing rather than as NaN', () => {
    expect(totalDurationSeconds([{ durationSeconds: 12 }, { durationSeconds: Number.NaN }])).toBe(12);
  });
});
