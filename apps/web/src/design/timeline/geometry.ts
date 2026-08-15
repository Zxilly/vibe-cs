/*
 * Design system, layer 1 of 3 — multi-track timeline prototype (spec §0.5).
 *
 * The vertical axis. Horizontal geometry is `timeScale.ts`; this is the part
 * that decides which lane a pointer is over.
 *
 * Every number is read off the 「10 多轨编辑器」artboard's track column:
 *
 *   <div style="height:26px;border-bottom:…"></div>            ← ruler
 *   <div style="height:62px;…">V2 叠加</div>                    ← video
 *   <div style="height:62px;…">V1 主画面</div>
 *   <div style="height:52px;…">A1 原声</div>                    ← audio
 *   <div style="height:52px;…">A2 音乐</div>
 *   <div style="height:44px;…">T1 字幕</div>                    ← subtitle
 *
 * with the clips inset 8px in a video lane and 6px in the others (`padding:8px 0`
 * / `padding:6px 0` on the lane, and `top:8px` / `top:6px` on the clip).
 *
 * Spec §3 has no token family for any of this — §10.1 note 8 records the same
 * situation for Toggle and Slider and settles it the same way: keep the drawn
 * geometry, name it once, cite the source. The head column is the exception; it
 * *is* a token (`--w-track-head`, spec §3.5) and the CSS reads it from there.
 *
 * Pixels, not tokens, is also what makes hit-testing possible: a pointer drag
 * has to turn a `clientY` delta into a lane index, and it cannot ask CSS.
 */

import type { Timeline, TrackKind } from './timelineModel';

/** Lane heights, by kind. */
export const TRACK_HEIGHT_PX: Record<TrackKind, number> = {
  video: 62,
  audio: 52,
  subtitle: 44,
};

/** Vertical inset of a clip inside its lane, by kind. */
export const CLIP_INSET_PX: Record<TrackKind, number> = {
  video: 8,
  audio: 6,
  subtitle: 6,
};

/** The ruler strip above the first lane — and the marker lane (see README). */
export const RULER_HEIGHT_PX = 26;

/** The playhead flag drawn on the ruler: `width:14px;height:12px`. */
export const PLAYHEAD_FLAG_PX = { width: 14, height: 12 } as const;

export interface TrackBand {
  trackId: string;
  kind: TrackKind;
  /** Distance from the top of the *lane area*, ruler excluded. */
  top: number;
  height: number;
}

/** Cumulative lane offsets, in artboard order (V2 on top, T1 at the bottom). */
export function trackBands(timeline: Timeline): TrackBand[] {
  let top = 0;
  return timeline.tracks.map((track) => {
    const height = TRACK_HEIGHT_PX[track.kind];
    const band: TrackBand = { trackId: track.id, kind: track.kind, top, height };
    top += height;
    return band;
  });
}

export function trackAreaHeight(timeline: Timeline): number {
  return timeline.tracks.reduce((total, track) => total + TRACK_HEIGHT_PX[track.kind], 0);
}

/** The lane a lane-area offset falls in; the nearest lane when it falls outside. */
export function trackAtOffset(timeline: Timeline, offsetPx: number): TrackBand | undefined {
  const bands = trackBands(timeline);
  if (bands.length === 0) return undefined;
  const hit = bands.find((band) => offsetPx >= band.top && offsetPx < band.top + band.height);
  if (hit !== undefined) return hit;
  return offsetPx < 0 ? bands[0] : bands[bands.length - 1];
}

/**
 * Where a drag that started on `fromTrackId` and has travelled `deltaPx`
 * vertically should drop. Measured centre-to-centre so a clip changes lane when
 * it is more than half way there, not when its top edge crosses.
 */
export function trackAfterVerticalDrag(timeline: Timeline, fromTrackId: string, deltaPx: number): TrackBand | undefined {
  const bands = trackBands(timeline);
  const from = bands.find((band) => band.trackId === fromTrackId);
  if (from === undefined) return undefined;
  return trackAtOffset(timeline, from.top + from.height / 2 + deltaPx);
}

/**
 * The nearest lane of the same kind at or beyond `direction`, for the keyboard
 * equivalent of a cross-track drag (ArrowUp / ArrowDown on a selected clip).
 * Returns undefined when there is none, so the caller can refuse audibly
 * instead of moving the clip somewhere illegal.
 */
export function adjacentTrackOfKind(
  timeline: Timeline,
  fromTrackId: string,
  direction: 1 | -1,
): string | undefined {
  const index = timeline.tracks.findIndex((track) => track.id === fromTrackId);
  const from = timeline.tracks[index];
  if (index < 0 || from === undefined) return undefined;
  for (let cursor = index + direction; cursor >= 0 && cursor < timeline.tracks.length; cursor += direction) {
    const candidate = timeline.tracks[cursor];
    if (candidate?.kind === from.kind) return candidate.id;
  }
  return undefined;
}
