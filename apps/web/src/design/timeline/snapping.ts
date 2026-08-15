/*
 * Design system, layer 1 of 3 — multi-track timeline prototype (spec §0.5).
 *
 * Snapping: 「拖拽时片段边缘吸到相邻片段边缘、播放头、标记，阈值以像素计并随缩放换算」.
 *
 * The pixel threshold is the whole point. A snap radius fixed in seconds would
 * feel sticky when zoomed out and useless when zoomed in; fixed in pixels it is
 * always the same distance under the cursor. So the radius enters in pixels and
 * is divided by `pixelsPerSecond` at the moment of use — which is why
 * `SnapOptions` takes a `TimeScale` rather than a duration.
 *
 * Both edges of the dragged clip compete. Dragging a 28s clip towards a
 * neighbour, the edge that touches first is the one that snaps, and the result
 * is expressed as a new `start` so the caller never has to reason about which
 * edge won.
 */

import type { Timeline } from './timelineModel';
import { clipEnd } from './timelineModel';
import { pxToTime, TIME_EPSILON, type TimeScale } from './timeScale';

export type SnapKind = 'playhead' | 'marker' | 'clip-start' | 'clip-end' | 'origin';

export interface SnapTarget {
  time: number;
  kind: SnapKind;
  /** Clip or marker id, when the target came from one. */
  id?: string;
}

/**
 * Tie-break order, applied only when two candidates are *equally* far away.
 * The playhead wins because the user parked it there on purpose; a marker
 * next, for the same reason; clip edges last because there are dozens of them.
 */
const KIND_PRIORITY: Record<SnapKind, number> = {
  playhead: 0,
  marker: 1,
  'clip-start': 2,
  'clip-end': 3,
  origin: 4,
};

/**
 * 8px. Wide enough to catch without aiming, narrow enough that a deliberate
 * placement 1s from a neighbour survives at 100% zoom (12px away).
 */
export const DEFAULT_SNAP_THRESHOLD_PX = 8;

export interface SnapOptions {
  scale: TimeScale;
  thresholdPx?: number;
}

export interface CollectOptions {
  /** The clips being dragged: their own edges must not attract them. */
  excludeClipIds?: ReadonlySet<string>;
  /** Restrict clip edges to these tracks. Omitted: every track contributes. */
  trackIds?: ReadonlySet<string>;
  includePlayhead?: boolean;
  includeMarkers?: boolean;
  /** t = 0, so a clip can always be flushed to the head of the sequence. */
  includeOrigin?: boolean;
}

/**
 * Everything a drag may stick to, in ascending time. Cross-track by design:
 * the artboard's V1 / A1 clips are cut on the same seams, and an editor that
 * only snapped within one lane would never let a video meet its own audio.
 */
export function collectSnapTargets(timeline: Timeline, options: CollectOptions = {}): SnapTarget[] {
  const {
    excludeClipIds = new Set<string>(),
    trackIds,
    includePlayhead = true,
    includeMarkers = true,
    includeOrigin = true,
  } = options;

  const targets: SnapTarget[] = [];
  if (includeOrigin) targets.push({ time: 0, kind: 'origin' });
  if (includePlayhead) targets.push({ time: timeline.playhead, kind: 'playhead' });
  if (includeMarkers) {
    for (const marker of timeline.markers) targets.push({ time: marker.time, kind: 'marker', id: marker.id });
  }

  for (const clip of timeline.clips) {
    if (excludeClipIds.has(clip.id)) continue;
    if (trackIds !== undefined && !trackIds.has(clip.trackId)) continue;
    targets.push({ time: clip.start, kind: 'clip-start', id: clip.id });
    targets.push({ time: clipEnd(clip), kind: 'clip-end', id: clip.id });
  }

  return targets.sort((a, b) => a.time - b.time || KIND_PRIORITY[a.kind] - KIND_PRIORITY[b.kind]);
}

/** Seconds covered by the pixel threshold at this zoom. */
export function snapRadiusSeconds({ scale, thresholdPx = DEFAULT_SNAP_THRESHOLD_PX }: SnapOptions): number {
  return pxToTime(scale, Math.max(0, thresholdPx));
}

export interface SnapResult {
  /** The snapped value, or the input when nothing was in range. */
  time: number;
  snapped: boolean;
  target?: SnapTarget;
  /** `time - input`. Zero when nothing snapped. */
  deltaSeconds: number;
}

/** Snaps a single instant — the playhead, or a razor cut. */
export function snapTime(time: number, targets: readonly SnapTarget[], options: SnapOptions): SnapResult {
  const radius = snapRadiusSeconds(options);
  let best: SnapTarget | undefined;
  let bestDistance = Number.POSITIVE_INFINITY;

  for (const target of targets) {
    const distance = Math.abs(target.time - time);
    if (distance > radius + TIME_EPSILON) continue;
    if (distance < bestDistance - TIME_EPSILON || (best !== undefined && isTieBreakWinner(target, best, distance, bestDistance))) {
      best = target;
      bestDistance = distance;
    }
  }

  if (best === undefined) return { time, snapped: false, deltaSeconds: 0 };
  return { time: best.time, snapped: true, target: best, deltaSeconds: best.time - time };
}

function isTieBreakWinner(candidate: SnapTarget, incumbent: SnapTarget, distance: number, bestDistance: number): boolean {
  if (Math.abs(distance - bestDistance) > TIME_EPSILON) return false;
  if (KIND_PRIORITY[candidate.kind] !== KIND_PRIORITY[incumbent.kind]) {
    return KIND_PRIORITY[candidate.kind] < KIND_PRIORITY[incumbent.kind];
  }
  return candidate.time < incumbent.time;
}

export interface EdgeSnapResult extends SnapResult {
  /** Which edge of the dragged clip did the sticking. */
  edge?: 'start' | 'end';
}

/**
 * Snaps a clip being dragged. `time` is the proposed left edge; the return's
 * `time` is the left edge to use.
 *
 * Both edges are offered, and the smaller correction wins — that is what makes
 * a clip feel like it has two magnets rather than one. A tie goes to the left
 * edge, because that is the one the pointer is nominally holding.
 */
export function snapClipStart(
  start: number,
  duration: number,
  targets: readonly SnapTarget[],
  options: SnapOptions,
): EdgeSnapResult {
  const radius = snapRadiusSeconds(options);
  let bestDelta = 0;
  let bestDistance = Number.POSITIVE_INFINITY;
  let bestTarget: SnapTarget | undefined;
  let bestEdge: 'start' | 'end' | undefined;

  const consider = (target: SnapTarget, edge: 'start' | 'end') => {
    const delta = edge === 'start' ? target.time - start : target.time - (start + duration);
    const distance = Math.abs(delta);
    if (distance > radius + TIME_EPSILON) return;

    if (distance < bestDistance - TIME_EPSILON) {
      [bestDelta, bestDistance, bestTarget, bestEdge] = [delta, distance, target, edge];
      return;
    }
    if (distance > bestDistance + TIME_EPSILON || bestTarget === undefined || bestEdge === undefined) return;
    // Equal distance: the left edge first, then the kind order, then the earlier time.
    if (bestEdge === 'end' && edge === 'start') {
      [bestDelta, bestDistance, bestTarget, bestEdge] = [delta, distance, target, edge];
      return;
    }
    if (bestEdge === edge && isTieBreakWinner(target, bestTarget, distance, bestDistance)) {
      [bestDelta, bestDistance, bestTarget, bestEdge] = [delta, distance, target, edge];
    }
  };

  for (const target of targets) {
    consider(target, 'start');
    consider(target, 'end');
  }

  if (bestTarget === undefined || bestEdge === undefined) return { time: start, snapped: false, deltaSeconds: 0 };
  return {
    time: start + bestDelta,
    snapped: true,
    target: bestTarget,
    edge: bestEdge,
    deltaSeconds: bestDelta,
  };
}
