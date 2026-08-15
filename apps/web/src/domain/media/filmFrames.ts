/*
 * Domain layer, layer 2 of 3 — media: where a film strip's cells sit in time.
 *
 * No React, no DOM, no video. `FilmStrip` decodes nothing: it is handed the
 * thumbnails, or it is handed nothing and draws placeholders at the times this
 * module computes.
 */

import { TIME_EPSILON } from '../../design/timeline';

import type { FilmFrame } from './types';

/**
 * `count` evenly spaced times across `[0, durationSeconds)`.
 *
 * A cell is labelled with the time of its *first* frame, not its midpoint,
 * because that is the frame a scrub to that cell would land on — the strip is
 * a coarse index into the media, and an index that points half a cell away
 * from what it names is worse than no index.
 *
 * A zero or negative duration, or a count below one, yields `[]`.
 */
export function evenFrameTimes(durationSeconds: number, count: number): number[] {
  const cells = Math.floor(count);
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) return [];
  if (!Number.isFinite(cells) || cells < 1) return [];

  const step = durationSeconds / cells;
  const times: number[] = [];
  for (let index = 0; index < cells; index += 1) times.push(round(index * step));
  return times;
}

/** The same times, as placeholder frames with no image behind them. */
export function placeholderFrames(durationSeconds: number, count: number): FilmFrame[] {
  return evenFrameTimes(durationSeconds, count).map((time) => ({ time }));
}

/**
 * Index of the cell a playhead is inside, or `-1` for an empty strip.
 *
 * "Inside", not "nearest": a strip cell stands for the span that begins at its
 * time, so a playhead at 3.9s belongs to the cell labelled 3.0s even though
 * 4.0s is closer. A time before the first cell takes the first cell.
 *
 * `times` is assumed ascending — `evenFrameTimes` produces it that way and a
 * caller-supplied strip that is not sorted is a caller bug, not a case to
 * silently repair.
 */
export function frameIndexAtTime(times: readonly number[], seconds: number): number {
  if (times.length === 0) return -1;
  if (!Number.isFinite(seconds)) return 0;

  let found = 0;
  for (let index = 0; index < times.length; index += 1) {
    if ((times[index] as number) <= seconds + TIME_EPSILON) found = index;
    else break;
  }
  return found;
}

/** Kills the drift of repeated multiplication on a float. */
function round(seconds: number): number {
  return Math.round(seconds * 1e6) / 1e6;
}
