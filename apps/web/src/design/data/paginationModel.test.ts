import { describe, expect, it } from 'vitest';

import { paginationRange, paginationSlotCount } from './paginationModel';

describe('paginationRange', () => {
  it('lists every page while they still fit', () => {
    expect(paginationRange(1, 5)).toEqual([1, 2, 3, 4, 5]);
    expect(paginationRange(4, 7)).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  it('elides the right-hand run near the start', () => {
    expect(paginationRange(2, 25)).toEqual([1, 2, 3, 4, 5, 'ellipsis', 25]);
  });

  it('elides the left-hand run near the end', () => {
    expect(paginationRange(24, 25)).toEqual([1, 'ellipsis', 21, 22, 23, 24, 25]);
  });

  it('elides both runs in the middle', () => {
    expect(paginationRange(13, 25)).toEqual([1, 'ellipsis', 12, 13, 14, 'ellipsis', 25]);
  });

  it('keeps a constant slot count across every page, which is what §15.4 calls stable', () => {
    const total = 25;
    const widths = new Set<number>();
    for (let page = 1; page <= total; page += 1) widths.add(paginationRange(page, total).length);
    expect([...widths]).toEqual([paginationSlotCount()]);
  });

  it('widens predictably with more siblings', () => {
    expect(paginationSlotCount(2)).toBe(9);
    expect(paginationRange(13, 40, { siblings: 2 })).toEqual([1, 'ellipsis', 11, 12, 13, 14, 15, 'ellipsis', 40]);
  });

  it('survives degenerate input', () => {
    expect(paginationRange(1, 0)).toEqual([1]);
    expect(paginationRange(-4, 3)).toEqual([1, 2, 3]);
    expect(paginationRange(99, 3)).toEqual([1, 2, 3]);
  });
});
