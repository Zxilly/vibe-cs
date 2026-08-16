/*
 * Design system, layer 1 of 3 — multi-track timeline (spec §0.5, phase 3f-2).
 *
 * The frame grid. README gap 3: 「时间全是浮点秒…真实素材是 60fps，入出点必须落
 * 在帧上，否则导出会出现半帧」.
 *
 * ## Where rounding happens, and where it must not
 *
 * Exactly one place: `quantizeTimeline`, called by `useTimelineEditor.commit`
 * on the document an operation produced, once per gesture. Not inside the
 * operations, and above all **not inside a preview**.
 *
 * That is not tidiness. A preview that quantised would make the clip under the
 * pointer lag it in 16ms steps, and at 0.125× zoom one frame is 0.19px — the
 * clip would visibly refuse to follow the cursor. The gesture stays continuous
 * and the *result* lands on the grid, which is also how snapping already
 * works: `snapping.ts` computes the target in seconds and the drag renders the
 * raw offset until the pointer comes up.
 *
 * ## Why the whole document and not the edited clips
 *
 * What makes a cut seamless is an invariant, not a rounding rule: *every*
 * `start` in the document sits on a frame. Given that, a razor at 4.007s is
 * safe — the left half's end is `start + round(duration)` and the right half's
 * start is `round(4.007)`, and because the left half's start was already on
 * the grid those two are the same number. Break the invariant for one clip and
 * the next cut on it lands a fraction of a frame off, which is a black flash
 * at the seam on export.
 *
 * Quantising the whole document is what maintains the invariant unconditionally.
 * Quantising only the clips an operation names would maintain it too — as long
 * as the caller enumerated every clip the operation touched, which for
 * `rippleDelete` is an entire track and for a link group is a set the call site
 * does not build. One missed clip is a silent, permanent hole in the invariant.
 * The document has a few hundred clips; walking all of them once per gesture is
 * not worth reasoning about.
 *
 * ## What is on the grid
 *
 * `start`, `duration` and `sourceIn`. Not `speed`: it is a ratio, and forcing
 * `duration * speed` onto the grid as well would mean no clip could play at
 * 1.5×. The export pipeline resamples; a source offset that lands mid-frame is
 * a decode seek, not a dropped frame, so `sourceIn` is rounded for tidiness
 * (an in point the Inspector prints as `00:00:04:08` should *be* frame 8) but
 * `sourceIn + duration * speed` is deliberately left wherever it lands.
 */

import type { Clip, Timeline } from './timelineModel';
import { TIME_EPSILON } from './timeScale';

/** Seconds one frame lasts. */
export function frameDuration(fps: number): number {
  return 1 / fps;
}

/** Frame index a time falls on, rounded to nearest. */
export function frameAt(seconds: number, fps: number): number {
  return Math.round(seconds * fps);
}

/**
 * `seconds` moved to the nearest frame boundary.
 *
 * The rounding is done in frames and divided back, never by `Math.round(t /
 * step) * step`: at 60fps the step is 0.016666…, and multiplying a large frame
 * count by that accumulates error that shows up as a clip an hour in sitting a
 * millisecond off the grid.
 */
export function quantizeToFrame(seconds: number, fps: number): number {
  return frameAt(seconds, fps) / fps;
}

/** Toward zero — for a duration that must not grow past what was measured. */
export function floorToFrame(seconds: number, fps: number): number {
  return Math.floor(seconds * fps + TIME_EPSILON) / fps;
}

/** Away from zero. */
export function ceilToFrame(seconds: number, fps: number): number {
  return Math.ceil(seconds * fps - TIME_EPSILON) / fps;
}

/** True when `seconds` already sits on a frame, within float slack. */
export function isOnFrame(seconds: number, fps: number): boolean {
  return Math.abs(seconds - quantizeToFrame(seconds, fps)) < TIME_EPSILON;
}

/**
 * A clip on the grid, with a duration of at least one frame.
 *
 * The minimum is why `duration` is not simply rounded: a clip that a trim left
 * 0.004s long would round to zero and `createTimeline` would throw on a
 * document the user produced by dragging, which is a refusal the operation
 * should have made, not a crash.
 */
export function quantizeClip(clip: Clip, fps: number): Clip {
  const step = frameDuration(fps);
  return {
    ...clip,
    start: Math.max(0, quantizeToFrame(clip.start, fps)),
    duration: Math.max(step, quantizeToFrame(clip.duration, fps)),
    sourceIn: Math.max(0, quantizeToFrame(clip.sourceIn, fps)),
  };
}

/**
 * A clip pulled back inside its source, after rounding pushed its window past
 * the end. Rounding up by half a frame at each edge can cost a whole frame of
 * source, and the media has exactly as much as it has.
 *
 * Two steps, in this order: slide the window left while there is room, and
 * only then give up a frame of duration. Sliding is invisible (the same
 * material, one frame earlier); shortening is not, and a clip that loses a
 * frame every time the document is quantised would erode.
 */
function fitInsideSource(clip: Clip, fps: number): Clip {
  const step = frameDuration(fps);
  const overrun = clip.sourceIn + clip.duration * clip.speed - clip.sourceDuration;
  if (overrun <= TIME_EPSILON) return clip;

  const slid = { ...clip, sourceIn: Math.max(0, clip.sourceIn - ceilToFrame(overrun, fps)) };
  const remaining = slid.sourceIn + slid.duration * slid.speed - slid.sourceDuration;
  if (remaining <= TIME_EPSILON) return slid;

  return { ...slid, duration: Math.max(step, floorToFrame(slid.duration - remaining / slid.speed, fps)) };
}

/**
 * Every clip and marker on the grid. The playhead too: it is what a razor cuts
 * at, so an unquantised playhead would put every cut back off the grid.
 *
 * The result is always a document `createTimeline` accepts — that is the whole
 * contract, since this runs between an operation and the undo stack.
 */
export function quantizeTimeline(timeline: Timeline): Timeline {
  const { fps } = timeline;
  return {
    ...timeline,
    clips: timeline.clips.map((clip) => fitInsideSource(quantizeClip(clip, fps), fps)),
    markers: timeline.markers.map((marker) => ({ ...marker, time: Math.max(0, quantizeToFrame(marker.time, fps)) })),
    playhead: Math.max(0, quantizeToFrame(timeline.playhead, fps)),
  };
}
