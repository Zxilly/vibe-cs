import { describe, expect, it } from 'vitest';

import { COLLAPSE_BREAKPOINT_PX, COLLAPSE_MEDIA_QUERY } from './collapse';

describe('the shell collapse breakpoint', () => {
  it('is the single 1100px breakpoint spec §8 names', () => {
    expect(COLLAPSE_BREAKPOINT_PX).toBe(1100);
  });

  // The 「1100 × 700 折叠规则」 artboard is drawn at exactly 1100 and shows the
  // folded state, so the bound has to be inclusive. `max-width: 1099px` would
  // leave the one width the design reference actually specifies unfolded.
  it('folds at the breakpoint itself, not one pixel below it', () => {
    expect(COLLAPSE_MEDIA_QUERY).toBe('(max-width: 1100px)');
  });
});
