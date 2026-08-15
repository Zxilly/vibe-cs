/*
 * Design system, layer 1 of 3 — multi-track timeline prototype (spec §0.5).
 *
 * What a drag in progress looks like: the last pure step before React.
 *
 * A pointermove gives two numbers — how far the pointer has travelled in x and
 * in y — and everything the UI needs follows from them: which lane the clip is
 * over, where its left edge would land after snapping, whether the drop would
 * be refused, and the single pixel offset the renderer writes to `--tl-dx`.
 *
 * Keeping that here rather than in the hook is what lets the whole drag be
 * tested without a DOM: `previewDrag` is a function of (document, dx, dy, zoom,
 * snap) and nothing else. The hook only remembers where the pointer went down.
 */

import { trackAfterVerticalDrag } from './geometry';
import { planMove, type OverlapPolicy } from './dragMove';
import { collectSnapTargets, snapClipStart, type SnapTarget } from './snapping';
import { getClip, linkGroup, type EditRefusal, type Timeline } from './timelineModel';
import { pxToTime, timeToPx, type TimeScale } from './timeScale';

export interface DragPreviewInput {
  timeline: Timeline;
  clipId: string;
  /** Pointer travel since the drag began. */
  deltaXPx: number;
  deltaYPx: number;
  scale: TimeScale;
  snapEnabled?: boolean;
  thresholdPx?: number;
  overlap?: OverlapPolicy;
}

export interface DragPreview {
  /** Where the clip's left edge would land. */
  start: number;
  /** Which lane it would land on. */
  trackId: string;
  /** What the renderer writes to `--tl-dx`. */
  offsetPx: number;
  /** The target the edge stuck to, for the snap indicator. */
  snap: SnapTarget | null;
  /** Non-null while the drop would be refused; the clip paints red. */
  refusal: EditRefusal | null;
}

export function previewDrag({
  timeline,
  clipId,
  deltaXPx,
  deltaYPx,
  scale,
  snapEnabled = true,
  thresholdPx,
  overlap = 'reject',
}: DragPreviewInput): DragPreview {
  const clip = getClip(timeline, clipId);
  if (clip === undefined) {
    return { start: 0, trackId: '', offsetPx: 0, snap: null, refusal: 'unknown-clip' };
  }

  // A drag that has not moved is not a drag. Without this a pointerdown alone
  // would snap the clip to whatever it happens to be near — in the artboard's
  // own sequence the V1 clips sit 0.167 s (2 frames) apart, well inside the
  // 8px radius, so merely selecting one would nudge it.
  if (deltaXPx === 0 && deltaYPx === 0) {
    return { start: clip.start, trackId: clip.trackId, offsetPx: 0, snap: null, refusal: null };
  }

  const rawStart = clip.start + pxToTime(scale, deltaXPx);
  const lane = trackAfterVerticalDrag(timeline, clip.trackId, deltaYPx);
  const trackId = lane?.trackId ?? clip.trackId;

  const group = linkGroup(timeline, clipId);
  const snapped = snapEnabled
    ? snapClipStart(rawStart, clip.duration, collectSnapTargets(timeline, {
        excludeClipIds: new Set(group.map((member) => member.id)),
      }), { scale, ...(thresholdPx === undefined ? {} : { thresholdPx }) })
    : { time: rawStart, snapped: false, deltaSeconds: 0, target: undefined };

  const plan = planMove(timeline, clipId, snapped.time, { toTrackId: trackId, overlap });

  // A refused drop still follows the pointer: the user has to see *where* the
  // clip is being taken in order to understand why it is being refused. Only a
  // clean plan is allowed to reposition it (which is also where the clamp at
  // t = 0 comes from).
  const refusal = plan.refusal === 'no-change' ? null : (plan.refusal ?? null);
  const start =
    plan.refusal === undefined || plan.refusal === 'no-change'
      ? clip.start + plan.deltaSeconds
      : Math.max(0, snapped.time);

  return {
    start,
    trackId,
    offsetPx: timeToPx(scale, start - clip.start),
    snap: snapped.target ?? null,
    refusal,
  };
}

/**
 * The slip equivalent: a horizontal drag with the slip tool moves the source
 * window, so there is no lane, no snap and no offset — only a delta, which
 * `slipClip` clamps when it is committed.
 */
export function previewSlip(scale: TimeScale, deltaXPx: number): number {
  return pxToTime(scale, deltaXPx);
}
