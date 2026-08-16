/*
 * Design system, layer 1 of 3 — multi-track timeline (spec §0.5, phase 3f-2).
 *
 * Dragging to the edge scrolls the timeline. README gap 2, which called it
 * 「这类控件公认的难点」 — and the difficulty is real, but it is not in the
 * arithmetic. It is in the loop.
 *
 * ## Why a drag cannot just scroll on pointermove
 *
 * A pointer held motionless one pixel inside the right edge fires no events.
 * If the scroll only advanced on `pointermove`, the timeline would creep while
 * the user wiggled and stop dead when they held still — the opposite of what
 * holding at the edge means. So the scroll is driven by a clock, and the
 * pointer only sets its *velocity*.
 *
 * That is why this file has two functions and no state: `autoScrollVelocity`
 * turns a pointer position into px/s, `advanceScroll` turns px/s plus elapsed
 * time into a new offset. The rAF loop that calls them lives in
 * `useTimelineEditor`, where it can also re-run the drag preview — because the
 * second half of the difficulty is that scrolling *is* pointer movement as far
 * as the document is concerned: the clip must keep following the cursor while
 * the ground moves under it, so every scroll step recomputes the preview from
 * the pointer's unchanged client coordinates.
 *
 * ## The shape of the ramp
 *
 * Linear in how deep the pointer is into the edge band, from zero at the inner
 * boundary to `maxSpeedPxPerSecond` at the outer. Quadratic feels better in a
 * map, worse here: an editor drag is aiming at a specific frame, and a ramp
 * that accelerates fast makes the last few pixels of correction impossible.
 *
 * Past the edge — the pointer has left the viewport — the speed stays at the
 * maximum rather than growing. There is no bound on how far outside a window a
 * pointer can go, and a proportional response would launch the playhead into
 * next week on a flick.
 */

/** Width of the band at each edge that pulls, in pixels. */
export const DEFAULT_EDGE_BAND_PX = 48;

/**
 * Top speed, px/s. At the artboard's 12 px/s scale this is 60 seconds of
 * timeline per second of holding — fast enough to cross a long sequence
 * without waiting, slow enough to stop where you meant to.
 */
export const DEFAULT_MAX_AUTO_SCROLL_PX_PER_SECOND = 720;

export interface AutoScrollInput {
  /** Pointer position relative to the viewport's left edge. */
  pointerViewportPx: number;
  viewportWidthPx: number;
  edgeBandPx?: number;
  maxSpeedPxPerSecond?: number;
}

/**
 * Scroll speed in px/s: negative pulls left, positive right, zero is the
 * middle of the viewport where nothing should happen.
 */
export function autoScrollVelocity({
  pointerViewportPx,
  viewportWidthPx,
  edgeBandPx = DEFAULT_EDGE_BAND_PX,
  maxSpeedPxPerSecond = DEFAULT_MAX_AUTO_SCROLL_PX_PER_SECOND,
}: AutoScrollInput): number {
  // A viewport narrower than two bands has no middle. Halving keeps a band at
  // each edge and leaves the centre inert, rather than letting the two overlap
  // into a control that scrolls both ways at once.
  const band = Math.min(edgeBandPx, viewportWidthPx / 2);
  if (!(band > 0) || !(viewportWidthPx > 0)) return 0;

  if (pointerViewportPx < band) {
    const depth = Math.min(1, (band - pointerViewportPx) / band);
    return -depth * maxSpeedPxPerSecond;
  }
  const fromRight = viewportWidthPx - pointerViewportPx;
  if (fromRight < band) {
    const depth = Math.min(1, (band - fromRight) / band);
    return depth * maxSpeedPxPerSecond;
  }
  return 0;
}

/**
 * The next scroll offset. Clamped at zero and at `maxScrollPx`, so a drag held
 * against the start of the timeline does not accumulate negative scroll that
 * has to be unwound before the view moves again.
 */
export function advanceScroll(
  scrollPx: number,
  velocityPxPerSecond: number,
  elapsedMs: number,
  maxScrollPx: number,
): number {
  const next = scrollPx + (velocityPxPerSecond * elapsedMs) / 1000;
  return Math.min(Math.max(0, maxScrollPx), Math.max(0, next));
}

/**
 * How far the content can scroll: its full width less the window. Negative
 * (content narrower than the window) collapses to zero rather than to a
 * negative bound that `advanceScroll` would clamp everything to.
 */
export function maxScrollPx(contentWidthPx: number, viewportWidthPx: number): number {
  return Math.max(0, contentWidthPx - viewportWidthPx);
}
