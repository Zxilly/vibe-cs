import { describe, expect, it } from 'vitest';

import {
  advanceScroll,
  autoScrollVelocity,
  DEFAULT_EDGE_BAND_PX,
  DEFAULT_MAX_AUTO_SCROLL_PX_PER_SECOND as MAX_SPEED,
  maxScrollPx,
} from './autoScroll';

const WIDE = { viewportWidthPx: 1000 };

describe('autoScrollVelocity', () => {
  it('is still in the middle', () => {
    for (const pointerViewportPx of [48, 200, 500, 800, 952]) {
      expect(autoScrollVelocity({ pointerViewportPx, ...WIDE })).toBe(0);
    }
  });

  it('pulls left in the left band and right in the right one', () => {
    expect(autoScrollVelocity({ pointerViewportPx: 24, ...WIDE })).toBeLessThan(0);
    expect(autoScrollVelocity({ pointerViewportPx: 976, ...WIDE })).toBeGreaterThan(0);
  });

  it('ramps linearly from the inner edge of the band to the outer', () => {
    // Linear, not quadratic: an editor drag is aiming at a frame, and a ramp
    // that accelerates fast makes the last few pixels of correction impossible.
    const half = autoScrollVelocity({ pointerViewportPx: DEFAULT_EDGE_BAND_PX / 2, ...WIDE });
    expect(half).toBeCloseTo(-MAX_SPEED / 2, 9);
    expect(autoScrollVelocity({ pointerViewportPx: 0, ...WIDE })).toBe(-MAX_SPEED);
  });

  it('does not accelerate past the maximum outside the viewport', () => {
    // There is no bound on how far outside a window a pointer can travel, so a
    // proportional response would launch the view on a flick.
    expect(autoScrollVelocity({ pointerViewportPx: -50, ...WIDE })).toBe(-MAX_SPEED);
    expect(autoScrollVelocity({ pointerViewportPx: -100_000, ...WIDE })).toBe(-MAX_SPEED);
    expect(autoScrollVelocity({ pointerViewportPx: 100_000, ...WIDE })).toBe(MAX_SPEED);
  });

  it('halves the bands rather than letting them overlap in a narrow viewport', () => {
    // Two 48px bands in a 60px viewport would make the centre pull both ways.
    const narrow = { viewportWidthPx: 60 };
    expect(autoScrollVelocity({ pointerViewportPx: 30, ...narrow })).toBe(0);
    expect(autoScrollVelocity({ pointerViewportPx: 5, ...narrow })).toBeLessThan(0);
    expect(autoScrollVelocity({ pointerViewportPx: 55, ...narrow })).toBeGreaterThan(0);
  });

  it('is inert before the viewport has been measured', () => {
    expect(autoScrollVelocity({ pointerViewportPx: 0, viewportWidthPx: 0 })).toBe(0);
  });

  it('takes a caller’s band and top speed', () => {
    expect(
      autoScrollVelocity({ pointerViewportPx: 0, viewportWidthPx: 1000, edgeBandPx: 10, maxSpeedPxPerSecond: 100 }),
    ).toBe(-100);
    expect(
      autoScrollVelocity({ pointerViewportPx: 20, viewportWidthPx: 1000, edgeBandPx: 10, maxSpeedPxPerSecond: 100 }),
    ).toBe(0);
  });
});

describe('advanceScroll', () => {
  it('advances by velocity × time', () => {
    expect(advanceScroll(0, 720, 1000, 10_000)).toBe(720);
    expect(advanceScroll(1000, -720, 500, 10_000)).toBe(640);
    // 100 − 360 is −260, which is not a scroll offset.
    expect(advanceScroll(100, -720, 500, 10_000)).toBe(0);
  });

  it('clamps at both ends rather than accumulating', () => {
    // A drag held against the start must not build up negative scroll that has
    // to be unwound before the view moves again.
    expect(advanceScroll(0, -720, 5000, 10_000)).toBe(0);
    expect(advanceScroll(9_900, 720, 5000, 10_000)).toBe(10_000);
  });

  it('does nothing on a zero-length frame', () => {
    expect(advanceScroll(500, 720, 0, 10_000)).toBe(500);
  });
});

describe('maxScrollPx', () => {
  it('is the content less the window', () => {
    expect(maxScrollPx(3000, 1000)).toBe(2000);
  });

  it('is zero when the content fits', () => {
    expect(maxScrollPx(500, 1000)).toBe(0);
  });
});
