/*
 * Design system, layer 1 of 3 — multi-track timeline prototype (spec §0.5).
 *
 * The document model and every query the edit operations are built out of.
 * No React, no DOM, no time: `Timeline` in, `Timeline` out, always a new
 * object. Spec §0.5: 「这些算法的正确性是整个编辑器的地基，必须能在 node 环境里
 * 快速穷举测试」.
 *
 * Shape, from the 「10 多轨编辑器」artboard:
 *
 *   V2 叠加   ─┐
 *   V1 主画面  ├── tracks, each with a kind that decides what may land on it
 *   A1 原声    │
 *   A2 音乐    │
 *   T1 字幕   ─┘
 *
 * and two amber vertical lines at 240px / 660px — the markers. Markers are
 * *not* a track here: the artboard draws them as full-height guides through
 * every lane, which is a property of the sequence, not of a row. The ruler is
 * their lane. See README.md.
 *
 * A clip carries both its timeline placement (`start`, `duration`) and its
 * window into the source media (`sourceIn`, `sourceDuration`). Keeping the two
 * apart is what makes 滑移 (slip) expressible at all — slip moves one and not
 * the other — and it is what the Inspector's 入点 / 出点 rows read from.
 */

import { TIME_EPSILON } from './timeScale';

export type TrackKind = 'video' | 'audio' | 'subtitle';

export interface Track {
  id: string;
  kind: TrackKind;
  /** The lane id drawn in the head column: V1 / A2 / T1. */
  name: string;
  /** The role word beside it: 主画面 / 原声 / 音乐 / 字幕. */
  role: string;
  /** A locked track refuses every edit that would change its clips. */
  locked?: boolean;
}

export interface Clip {
  id: string;
  trackId: string;
  /** Left edge on the timeline, seconds. */
  start: number;
  /** Length on the timeline, seconds. Always > 0. */
  duration: number;
  /** Offset of the clip's first frame inside the source media, seconds. */
  sourceIn: number;
  /** Full length of the source media, seconds. `duration` may not exceed it. */
  sourceDuration: number;
  label: string;
  /**
   * Clips sharing a `linkId` are one A/V pair: they move, split, ripple and
   * slip together. The artboard's Inspector draws the switch — 「与视频链接」.
   */
  linkId?: string;
}

export interface Marker {
  id: string;
  time: number;
  label: string;
}

export interface Timeline {
  readonly tracks: readonly Track[];
  readonly clips: readonly Clip[];
  readonly markers: readonly Marker[];
  /** Seconds. Snapping treats it as a target; the ruler draws it. */
  readonly playhead: number;
}

/** The shape a caller hands to `createTimeline`; ordering is not its problem. */
export interface TimelineInput {
  tracks: readonly Track[];
  clips: readonly Clip[];
  markers?: readonly Marker[];
  playhead?: number;
}

/* ── construction ────────────────────────────────────────────────────────── */

/**
 * Deterministic order for everything, so two timelines that mean the same thing
 * compare equal in a test: clips by track order, then start, then id.
 */
export function sortClips(timeline: Pick<Timeline, 'tracks'>, clips: readonly Clip[]): Clip[] {
  const trackOrder = new Map(timeline.tracks.map((track, index) => [track.id, index]));
  return [...clips].sort((a, b) => {
    const byTrack = (trackOrder.get(a.trackId) ?? Number.MAX_SAFE_INTEGER) - (trackOrder.get(b.trackId) ?? Number.MAX_SAFE_INTEGER);
    if (byTrack !== 0) return byTrack;
    if (Math.abs(a.start - b.start) > TIME_EPSILON) return a.start - b.start;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

/**
 * Validates and normalises. Throws rather than repairing: every invariant here
 * is one an edit operation is allowed to assume, and a silently repaired
 * document would hide the bug that produced it.
 */
export function createTimeline(input: TimelineInput): Timeline {
  const trackIds = new Set<string>();
  for (const track of input.tracks) {
    if (trackIds.has(track.id)) throw new Error(`duplicate track id: ${track.id}`);
    trackIds.add(track.id);
  }

  const clipIds = new Set<string>();
  for (const clip of input.clips) {
    if (clipIds.has(clip.id)) throw new Error(`duplicate clip id: ${clip.id}`);
    clipIds.add(clip.id);
    if (!trackIds.has(clip.trackId)) throw new Error(`clip ${clip.id} names an unknown track: ${clip.trackId}`);
    if (!(clip.duration > 0)) throw new Error(`clip ${clip.id} has a non-positive duration`);
    if (clip.start < -TIME_EPSILON) throw new Error(`clip ${clip.id} starts before zero`);
    if (clip.sourceIn < -TIME_EPSILON) throw new Error(`clip ${clip.id} has a negative source in point`);
    if (clip.sourceIn + clip.duration > clip.sourceDuration + TIME_EPSILON) {
      throw new Error(`clip ${clip.id} runs past the end of its source`);
    }
  }

  const markerIds = new Set<string>();
  for (const marker of input.markers ?? []) {
    if (markerIds.has(marker.id)) throw new Error(`duplicate marker id: ${marker.id}`);
    markerIds.add(marker.id);
  }

  return {
    tracks: [...input.tracks],
    clips: sortClips(input, input.clips),
    markers: [...(input.markers ?? [])].sort((a, b) => a.time - b.time || (a.id < b.id ? -1 : 1)),
    playhead: Math.max(0, input.playhead ?? 0),
  };
}

/* ── clip geometry ───────────────────────────────────────────────────────── */

export function clipEnd(clip: Clip): number {
  return clip.start + clip.duration;
}

/** Out point inside the source media. Speed is fixed at 100% in this prototype. */
export function clipSourceOut(clip: Clip): number {
  return clip.sourceIn + clip.duration;
}

/** How far the source window can still travel left / right — the slip range. */
export function slipRange(clip: Clip): { min: number; max: number } {
  return { min: -clip.sourceIn, max: clip.sourceDuration - clipSourceOut(clip) };
}

/** Touching edges do not overlap: `[0,4)` and `[4,8)` are neighbours. */
export function rangesOverlap(aStart: number, aEnd: number, bStart: number, bEnd: number): boolean {
  return aStart < bEnd - TIME_EPSILON && bStart < aEnd - TIME_EPSILON;
}

export function clipsOverlap(a: Clip, b: Clip): boolean {
  return a.trackId === b.trackId && rangesOverlap(a.start, clipEnd(a), b.start, clipEnd(b));
}

/** True while `time` falls inside the clip, edges excluded. */
export function clipContains(clip: Clip, time: number): boolean {
  return time > clip.start + TIME_EPSILON && time < clipEnd(clip) - TIME_EPSILON;
}

/* ── queries ─────────────────────────────────────────────────────────────── */

export function getClip(timeline: Timeline, clipId: string): Clip | undefined {
  return timeline.clips.find((clip) => clip.id === clipId);
}

export function getTrack(timeline: Timeline, trackId: string): Track | undefined {
  return timeline.tracks.find((track) => track.id === trackId);
}

export function trackIndex(timeline: Timeline, trackId: string): number {
  return timeline.tracks.findIndex((track) => track.id === trackId);
}

/** Clips of one track, already in start order (`createTimeline` sorted them). */
export function clipsOnTrack(timeline: Timeline, trackId: string): Clip[] {
  return timeline.clips.filter((clip) => clip.trackId === trackId);
}

/** The clip under `time` on a track, or undefined in a gap. */
export function clipAt(timeline: Timeline, trackId: string, time: number): Clip | undefined {
  return timeline.clips.find((clip) => clip.trackId === trackId && clipContains(clip, time));
}

/**
 * The A/V link group of a clip: itself plus every clip sharing its `linkId`,
 * the clip itself first. An unlinked clip is a group of one, so callers never
 * branch on whether a link exists.
 */
export function linkGroup(timeline: Timeline, clipId: string): Clip[] {
  const clip = getClip(timeline, clipId);
  if (clip === undefined) return [];
  if (clip.linkId === undefined) return [clip];
  const partners = timeline.clips.filter((other) => other.id !== clip.id && other.linkId === clip.linkId);
  return [clip, ...partners];
}

/** Clips on `trackId` that would collide with `[start, end)`. */
export function findOverlapping(
  timeline: Timeline,
  trackId: string,
  start: number,
  end: number,
  exclude: ReadonlySet<string> = new Set(),
): Clip[] {
  return timeline.clips.filter(
    (clip) => clip.trackId === trackId && !exclude.has(clip.id) && rangesOverlap(start, end, clip.start, clipEnd(clip)),
  );
}

/** End of the last clip. An empty timeline is 0 long. */
export function timelineDuration(timeline: Timeline): number {
  return timeline.clips.reduce((longest, clip) => Math.max(longest, clipEnd(clip)), 0);
}

/* ── immutable updates ───────────────────────────────────────────────────── */

/** Replaces the clip set wholesale, re-sorting. Everything else is preserved. */
export function withClips(timeline: Timeline, clips: readonly Clip[]): Timeline {
  return { ...timeline, clips: sortClips(timeline, clips) };
}

/** Applies a patch to some clips and leaves the rest alone. */
export function patchClips(timeline: Timeline, patches: ReadonlyMap<string, Partial<Clip>>): Timeline {
  return withClips(
    timeline,
    timeline.clips.map((clip) => {
      const patch = patches.get(clip.id);
      return patch === undefined ? clip : { ...clip, ...patch };
    }),
  );
}

export function removeClips(timeline: Timeline, clipIds: ReadonlySet<string>): Timeline {
  return withClips(
    timeline,
    timeline.clips.filter((clip) => !clipIds.has(clip.id)),
  );
}

export function withPlayhead(timeline: Timeline, seconds: number): Timeline {
  return { ...timeline, playhead: Math.max(0, seconds) };
}

export function withMarkers(timeline: Timeline, markers: readonly Marker[]): Timeline {
  return { ...timeline, markers: [...markers].sort((a, b) => a.time - b.time || (a.id < b.id ? -1 : 1)) };
}

/* ── id minting ──────────────────────────────────────────────────────────── */

/**
 * A fresh id derived from an existing one, deterministically: `c1` → `c1~2` →
 * `c1~3`. Determinism is not cosmetic — a razor cut that produced a random id
 * could not be asserted on, and the operations have to stay pure functions
 * (no counter, no clock, no `crypto`).
 */
export function mintId(taken: ReadonlySet<string>, base: string): string {
  const stem = base.replace(/~\d+$/u, '');
  for (let suffix = 2; suffix < 10_000; suffix += 1) {
    const candidate = `${stem}~${suffix}`;
    if (!taken.has(candidate)) return candidate;
  }
  throw new Error(`cannot mint an id from ${base}`);
}

export function clipIdSet(timeline: Timeline): Set<string> {
  return new Set(timeline.clips.map((clip) => clip.id));
}

export function linkIdSet(timeline: Timeline): Set<string> {
  const ids = new Set<string>();
  for (const clip of timeline.clips) if (clip.linkId !== undefined) ids.add(clip.linkId);
  return ids;
}

/* ── shared result shape ─────────────────────────────────────────────────── */

/**
 * Every edit reports whether it happened and, when it did not, why. An
 * operation never throws on a refusal: a razor at a clip edge and a drag onto
 * an occupied track are ordinary user gestures, not programming errors, and
 * the UI has to say what it declined to do (设计稿：「不隐藏、不静默失败」).
 */
export type EditRefusal =
  | 'unknown-clip'
  | 'unknown-track'
  | 'track-locked'
  | 'track-kind-mismatch'
  | 'overlap'
  /** The instant asked for is outside the clip, or before t = 0. */
  | 'out-of-bounds'
  /** A slip with no source left to slip into — a different thing to say. */
  | 'no-headroom'
  | 'no-change';

export interface EditResult {
  timeline: Timeline;
  applied: boolean;
  reason?: EditRefusal;
}

export function refuse(timeline: Timeline, reason: EditRefusal): EditResult {
  return { timeline, applied: false, reason };
}
