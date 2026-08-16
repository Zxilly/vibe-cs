/*
 * Design system, layer 1 of 3 — multi-track timeline (spec §0.5, phase 3f-2).
 *
 * Which clips are worth putting in the DOM. README gap 4: 「每个片段一个 DOM
 * 节点，全部渲染。十几条没问题，几千条（一场比赛的全部击杀切片）没测过」.
 *
 * ## Horizontal only, and why that is the whole problem
 *
 * A timeline is unbounded in one direction and tiny in the other: 「10」 has
 * five lanes and would have eight if every kind were doubled, but a match's
 * kill clips number in the hundreds and a two-hour demo at 0.125× zoom is
 * 15 000 px wide. So the lanes are all rendered, always — they are five nodes,
 * and virtualising them would cost more in scroll bookkeeping than it saves —
 * and the clips inside them are windowed by time.
 *
 * This is also why `@tanstack/react-virtual` is not here. It solves a
 * different shape: a list of uniform rows in a scroll container, where item
 * *i* is at offset `i * size`. Timeline clips have no index-to-offset
 * relationship at all — their position is their `start`, an arbitrary float —
 * so the only part of that library that would apply is the scroll listener,
 * which the timeline already owns because zoom anchoring needs it. Spec §1.2's
 * rule about earning a dependency: it would not.
 *
 * ## Overscan is measured in pixels, not clips
 *
 * A count-based overscan ("render 10 more each way") is meaningless here: ten
 * clips is 4 seconds on a dense track and 6 minutes on a sparse one. Pixels
 * are what the user can actually scroll into before React re-renders, so the
 * band is a pixel margin converted to time at the current scale.
 *
 * ## Nothing under the pointer is ever culled
 *
 * A clip being dragged travels *away* from where it is; a clip that is
 * selected is what the Inspector is describing. Both must stay mounted even
 * when their position has left the window, or the drag loses its own node
 * mid-gesture. `keepIds` is that guarantee, and it is a set rather than a
 * single id because a link group moves as one.
 */

import { clipEnd, type Clip, type Timeline } from './timelineModel';
import { pxToTime, type TimeScale } from './timeScale';

/** The horizontal window, in content pixels. */
export interface TimelineViewport {
  /** Content pixels hidden to the left. */
  scrollPx: number;
  /** Visible width. Zero means "not measured yet" — see `visibleClips`. */
  widthPx: number;
}

export interface VirtualizeOptions {
  /** Extra band rendered either side, in pixels. */
  overscanPx?: number;
  /** Clips that must be rendered wherever they are. */
  keepIds?: ReadonlySet<string>;
}

/**
 * 600px each way at the artboard's 12 px/s is 50 seconds of headroom — more
 * than a fast flick covers between two animation frames, and cheap: at the
 * densest realistic spacing it is a few dozen extra nodes.
 */
export const DEFAULT_OVERSCAN_PX = 600;

/** The time band that should be mounted, given the window and the overscan. */
export function visibleTimeRange(
  scale: TimeScale,
  viewport: TimelineViewport,
  overscanPx = DEFAULT_OVERSCAN_PX,
): { from: number; to: number } {
  const from = pxToTime(scale, viewport.scrollPx - overscanPx);
  const to = pxToTime(scale, viewport.scrollPx + viewport.widthPx + overscanPx);
  return { from: Math.max(0, from), to };
}

/**
 * The clips to render.
 *
 * An unmeasured viewport (`widthPx === 0`) renders everything. That is the
 * first paint, before the ref has a layout: culling to a zero-width window
 * would render an empty timeline and then fill it in, which flashes. Falling
 * back to "all of them" is correct-if-slow, and the second paint is windowed.
 */
export function visibleClips(
  timeline: Timeline,
  scale: TimeScale,
  viewport: TimelineViewport,
  options: VirtualizeOptions = {},
): Clip[] {
  const { overscanPx = DEFAULT_OVERSCAN_PX, keepIds } = options;
  if (viewport.widthPx <= 0) return [...timeline.clips];

  const { from, to } = visibleTimeRange(scale, viewport, overscanPx);
  return timeline.clips.filter(
    (clip) => (keepIds?.has(clip.id) ?? false) || (clip.start < to && clipEnd(clip) > from),
  );
}

/**
 * How many clips the window is hiding — what a test asserts on to prove the
 * culling happened, and what a diagnostic readout would print. Kept beside the
 * filter so the two cannot disagree about what "visible" means.
 */
export function culledClipCount(
  timeline: Timeline,
  scale: TimeScale,
  viewport: TimelineViewport,
  options: VirtualizeOptions = {},
): number {
  return timeline.clips.length - visibleClips(timeline, scale, viewport, options).length;
}
